import { SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed } from '../framework/ui';
import { coopLevelOf } from '../framework/views';
import { renderPostcardImage } from '../render';
import {
  CAPTION_MAX_LENGTH,
  growthStageIndex,
  pickStampSubject,
  sanitizeCaption,
  type PostcardPlot,
  type PostcardRenderInput,
} from '../render/postcard';
import * as playerRepo from '../repositories/player.repo';
import * as animalService from '../services/animal.service';
import * as farmService from '../services/farm.service';
import { gameError } from '../utils/errors';
import type { Command } from '../types';

/**
 * `/postcard [caption]` — une carte postale de sa ferme, à montrer au salon.
 *
 * La réponse est PUBLIQUE, et c'est tout l'intérêt : `/farm` sert à jouer,
 * `/postcard` sert à partager. Le cooldown (`balance.cooldowns.postcard`,
 * dix minutes) est là pour que la carte reste un geste et non un spam
 * d'images de 300 Ko.
 *
 * Vie privée : une ferme `private` refuse les visites, mais ici c'est le
 * fermier lui-même qui envoie sa carte — elle reste possible. Elle omet
 * simplement les pièces, seule donnée de la carte qu'un joueur peut vouloir
 * garder pour lui.
 */

const COOLDOWN_BUCKET = 'postcard';
const DEFAULT_TIMEZONE = 'Europe/Paris';

const cartePostale: Command = {
  category: 'social',
  cooldown: { seconds: 600, bucket: COOLDOWN_BUCKET },
  data: new SlashCommandBuilder()
    .setName('postcard')
    .setDescription('Send a postcard of your farm to this channel, for everyone to see')
    .addStringOption((option) =>
      option
        .setName('caption')
        .setDescription(`A short handwritten note on the card (${CAPTION_MAX_LENGTH} characters max)`)
        .setMaxLength(CAPTION_MAX_LENGTH)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const player = context.player;
    const { t, locale, now, config: catalog } = context;

    const caption = sanitizeCaption(interaction.options.getString('caption'));
    const coopLevel = await coopLevelOf(player.coopId);
    const [view, herd, settings] = await Promise.all([
      farmService.getFarmView(player, { coopLevel, now }),
      animalService.getHerd(player, now),
      playerRepo.getSettings(player.id),
    ]);

    const plots: PostcardPlot[] = view.plots.map((plot) => ({
      slot: plot.slot,
      x: plot.x,
      y: plot.y,
      locked: plot.state === 'locked',
      fertility: plot.fertility,
      crop: plot.crop
        ? {
            key: plot.crop.key,
            stage: growthStageIndex(plot.crop.growth.stage),
            ready: plot.crop.growth.ready,
            withered: plot.crop.growth.withered,
          }
        : null,
    }));
    const animals = herd.animals.map((animal) => {
      const species = catalog.animals.get(animal.animalKey);
      return {
        animalKey: animal.animalKey,
        emoji: animal.emoji,
        form: species?.form ?? null,
        palette: species?.palette ?? null,
      };
    });

    const input: PostcardRenderInput = {
      locale,
      farmId: view.farmId,
      farmName: view.name,
      farmer: {
        name: interaction.user.displayName,
        level: player.level,
        prestige: player.prestige,
        coins: settings?.privacy === 'private' ? null : player.coins,
      },
      caption,
      date: now,
      timezone: settings?.timezone ?? DEFAULT_TIMEZONE,
      season: view.world.season.season,
      weather: {
        weather: view.world.weather.weather,
        label: view.world.weather.label,
        temperature: view.world.weather.temperature,
      },
      grid: view.grid,
      plots,
      animals,
      buildings: herd.ownedBuildings,
      stamp: pickStampSubject(plots, animals),
    };

    const image = await renderPostcardImage(input);
    if (!image.attachment) {
      // Sans image, il n'y a pas de carte : contrairement à `/farm`, aucun
      // repli texte n'a de sens. On lève une `GameError` — le pipeline rend
      // alors son délai au joueur, qui ne paie pas dix minutes pour rien.
      throw gameError('busy', 'postcard could not be rendered', {
        i18nKey: 'errors.postcard.render_failed',
      });
    }

    await interaction.editReply({
      embeds: [
        baseEmbed({
          title: t('postcard.title', { name: interaction.user.displayName }),
          description: t('postcard.body', { name: interaction.user.displayName, farm: view.name }),
          color: COLORS.gold,
          footer: t('postcard.footer'),
        }),
      ],
      // Pièce jointe libre, hors de l'embed : voir la note dans `farmView`.
      files: [image.attachment],
      // Aucune mention ne doit partir d'un message public bâti sur des noms
      // choisis par des joueurs.
      allowedMentions: { parse: [] },
    });
  },
};

export const commands: Command[] = [cartePostale];
