import { SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, button, row } from '../framework/ui';
import { NO_IMAGE, renderFishingImage } from '../render';
import * as fishingService from '../services/fishing.service';
import { getWorldState } from '../services/world.service';
import { moduleLogger } from '../utils/logger';
import type { Command } from '../types';

const log = moduleLogger('fishing-cmd');

/**
 * Lance une ligne à l'étang. Le message initial édité une seconde fois, à la
 * touche, via un simple `setTimeout` : l'interaction reste éditable 15 minutes,
 * et une attente de quelques secondes ne justifie aucune tâche planifiée.
 */
const peche: Command = {
  category: 'agriculture',
  cooldown: { seconds: 6 },
  data: new SlashCommandBuilder()
    .setName('fish')
    .setDescription('Cast a line at the pond, then hook your catch in time')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();

    const result = await fishingService.cast(context.player, context.now);
    const world = await getWorldState(context.now, context.locale);
    const image = context.player.compactMode
      ? NO_IMAGE
      : await renderFishingImage({
          locale: context.locale,
          season: world.season.season,
          weather: world.weather.weather,
        });

    const components = [
      row(
        button({
          namespace: 'fishing',
          action: 'hook',
          ownerId: context.player.discordId,
          params: [result.castId],
          label: context.t('fishing.hook_button'),
          emoji: '🪝',
        }),
      ),
    ];

    // L'image est purement atmosphérique (l'étang, la météo) : si le rendu
    // échoue ou dépasse son budget, le titre et la description suffisent, pas
    // besoin d'un repli texte dédié comme pour la grille de ferme.
    const waitingEmbed = baseEmbed({
      title: context.t('fishing.cast_title'),
      description: context.t('fishing.cast_body'),
      color: COLORS.info,
    });

    await interaction.editReply({
      embeds: [waitingEmbed],
      components,
      files: image.attachment ? [image.attachment] : [],
    });

    const delay = Math.max(0, result.biteAt - Date.now());
    setTimeout(() => {
      const bitingEmbed = baseEmbed({
        title: context.t('fishing.bite_title'),
        description: context.t('fishing.bite_body'),
        color: COLORS.warning,
      });
      interaction.editReply({ embeds: [bitingEmbed], components }).catch((error: unknown) => {
        log.debug({ err: error }, 'édition « ça mord » impossible (message probablement expiré)');
      });
    }, delay);
  },
};

export const commands: Command[] = [peche];
