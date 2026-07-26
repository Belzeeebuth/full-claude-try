import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { buildHarvestEmbed, appendTracking } from '../../commands/farm';
import { auctionListView } from '../../commands/trade';
import { helpEmbed, TUTORIAL_STEPS } from '../../commands/start';
import { sendLeaderboard, helpFarmer } from '../../commands/social';
import { applyLocale, isSupported } from '../../commands/language';
import { COLORS, baseEmbed, button, quantityModal, row, successEmbed, textModal } from '../../framework/ui';
import {
  animalsView,
  buildingsView,
  coopView,
  farmView,
  inventoryView,
  marketView,
  plotsView,
  productionView,
  questsView,
  shopView,
} from '../../framework/views';
import { replyEphemeral } from '../../framework/interaction';
import * as animalService from '../../services/animal.service';
import * as craftService from '../../services/craft.service';
import * as farmService from '../../services/farm.service';
import * as inventoryService from '../../services/inventory.service';
import * as miscService from '../../services/misc.service';
import * as progressionService from '../../services/progression.service';
import * as playerRepo from '../../repositories/player.repo';
import { paramInt, paramString } from '../../utils/custom-id';
import { formatCoins, formatNumber } from '../../utils/format';
import type { ButtonHandler, CommandContext } from '../../types';

/**
 * Gestionnaires de boutons.
 *
 * Deux règles systématiques :
 *  - `deferUpdate()` pour les actions qui remplacent le message (navigation,
 *    rafraîchissement) : Discord attend un accusé en 3 s, et l'édition qui suit
 *    peut prendre le temps nécessaire ;
 *  - réponse ÉPHÉMÈRE pour les résultats d'action individuels, afin de ne pas
 *    noyer le salon sous les confirmations.
 */

// ---------------------------------------------------------------------------
// Ferme
// ---------------------------------------------------------------------------

const farmButtons: ButtonHandler = {
  namespace: 'farm',
  actions: ['refresh', 'harvest_all', 'water_all', 'plant_menu', 'plots', 'buy_plot', 'weed_all', 'page', 'noop'],
  lockKey: 'farm-action',

  async execute(interaction: ButtonInteraction, parsed, context: CommandContext): Promise<void> {
    switch (parsed.action) {
      case 'noop':
        await interaction.deferUpdate();
        return;

      case 'refresh': {
        await interaction.deferUpdate();
        await interaction.editReply(
          await farmView(context, {
            targetName: interaction.user.displayName,
            avatarUrl: interaction.user.displayAvatarURL({ extension: 'png', size: 128 }),
          }),
        );
        return;
      }

      case 'plots':
      case 'page': {
        await interaction.deferUpdate();
        const page = parsed.action === 'page' ? paramInt(parsed, 0, { min: 1, fallback: 1 }) : 1;
        await interaction.editReply(await plotsView(context, page));
        return;
      }

      case 'harvest_all': {
        await interaction.deferUpdate();
        const summary = await farmService.harvest(context.player, { all: true });
        await interaction.followUp({
          embeds: [buildHarvestEmbed(summary)],
          flags: MessageFlags.Ephemeral,
        });
        await interaction.editReply(await farmView(context));
        return;
      }

      case 'water_all': {
        await interaction.deferUpdate();
        const result = await farmService.water(context.player, { all: true });
        await interaction.followUp({
          embeds: [
            result.freeRain
              ? baseEmbed({
                  title: '🌧️ Il pleut !',
                  description: 'Vos parcelles sont arrosées gratuitement aujourd\'hui.',
                  color: COLORS.info,
                })
              : successEmbed('💧 Arrosage', `**${result.watered}** parcelle(s) arrosée(s).`),
          ],
          flags: MessageFlags.Ephemeral,
        });
        await interaction.editReply(await farmView(context));
        return;
      }

      case 'weed_all': {
        await interaction.deferUpdate();
        const result = await farmService.weed(context.player, { all: true });
        await interaction.followUp({
          embeds: [
            successEmbed(
              '🌿 Désherbage',
              `**${result.slots.length}** parcelle(s) nettoyée(s), **${result.weedsCollected}** mauvaises herbes récupérées.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        await interaction.editReply(await plotsView(context, 1));
        return;
      }

      case 'buy_plot': {
        await interaction.deferUpdate();
        const result = await farmService.buyPlot(context.player);
        await interaction.followUp({
          embeds: [
            successEmbed(
              '🗺️ Parcelle débloquée',
              `Parcelle **${result.slot}** pour ${formatCoins(result.cost)}.\nFerme : ${result.grid.width}×${result.grid.height}${result.nextCost > 0 ? `\nProchaine : ${formatCoins(result.nextCost)}` : ''}`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        await interaction.editReply(await plotsView(context, 1));
        return;
      }

      case 'plant_menu': {
        // Menu de sélection des graines disponibles.
        const seeds = await farmService.plantableCrops(context.player.id, context.player.level, '');
        if (seeds.length === 0) {
          await replyEphemeral(interaction, {
            embeds: [
              baseEmbed({
                title: '🌱 Aucune graine',
                description: 'Achetez-en avec `/shop` ou `/buy objet:seed_wheat`.',
                color: COLORS.warning,
              }),
            ],
          });
          return;
        }

        const { select, selectRow } = await import('../../framework/ui');
        await replyEphemeral(interaction, {
          embeds: [
            baseEmbed({
              title: '🌱 Que voulez-vous planter ?',
              description: 'La culture choisie sera plantée sur toutes vos parcelles vides.',
              color: COLORS.primary,
            }),
          ],
          components: [
            selectRow(
              select({
                namespace: 'farm',
                action: 'plant',
                ownerId: interaction.user.id,
                placeholder: 'Choisissez une culture',
                choices: seeds.map((entry) => ({
                  label: `${entry.crop.name} — ${entry.owned} graine(s)`,
                  value: entry.crop.key,
                  emoji: entry.crop.emoji,
                  description: `${Math.round(entry.crop.growthSeconds / 60)} min • ${entry.crop.baseYield}× ${entry.crop.sellPrice} pièces`,
                })),
              }),
            ),
          ],
        });
        return;
      }

      default:
        await interaction.deferUpdate();
    }
  },
};

// ---------------------------------------------------------------------------
// Inventaire, boutique, marché
// ---------------------------------------------------------------------------

const inventoryButtons: ButtonHandler = {
  namespace: 'inv',
  actions: ['open', 'page', 'sell_menu', 'discard', 'noop'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    if (parsed.action === 'noop') {
      await interaction.deferUpdate();
      return;
    }

    if (parsed.action === 'discard') {
      const decision = paramString(parsed, 0);
      const itemKey = paramString(parsed, 1);
      const quantity = paramInt(parsed, 2, { min: 1, fallback: 1 });

      if (decision !== 'yes') {
        await interaction.update({
          embeds: [baseEmbed({ title: '↩️ Annulé', description: 'Rien n\'a été jeté.', color: COLORS.neutral })],
          components: [],
        });
        return;
      }

      const { withTransaction } = await import('../../db/client');
      await withTransaction(async (tx) => {
        await inventoryService.consume(context.player.id, itemKey, quantity, tx);
      });
      const item = inventoryService.requireItem(itemKey);
      await interaction.update({
        embeds: [successEmbed('🗑️ Objets jetés', `${quantity}× ${item.emoji} ${item.name} ont été jetés.`)],
        components: [],
      });
      return;
    }

    if (parsed.action === 'sell_menu') {
      await replyEphemeral(interaction, {
        embeds: [
          baseEmbed({
            title: '💰 Vendre',
            description:
              'Utilisez `/sell objet:… quantité:tout` pour vendre au village,\n' +
              'ou `/auction sell` pour proposer votre lot aux autres joueurs (prix plein, commission de 5 %).',
            color: COLORS.gold,
          }),
        ],
      });
      return;
    }

    await interaction.deferUpdate();
    const page = parsed.action === 'page' ? paramInt(parsed, 0, { min: 1, fallback: 1 }) : 1;
    const category = paramString(parsed, parsed.action === 'page' ? 1 : 0, 'all');
    await interaction.editReply(
      await inventoryView(context, {
        category: category === 'all' ? undefined : category,
        page,
      }),
    );
  },
};

const shopButtons: ButtonHandler = {
  namespace: 'shop',
  actions: ['open', 'filter'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const category = parsed.action === 'filter' ? paramString(parsed, 0, 'all') : 'all';
    await interaction.editReply(await shopView(context, category === 'all' ? undefined : category));
  },
};

const marketButtons: ButtonHandler = {
  namespace: 'market',
  actions: ['open', 'filter'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const category = parsed.action === 'filter' ? paramString(parsed, 0, 'all') : 'all';
    await interaction.editReply(await marketView(context, category === 'all' ? undefined : category));
  },
};

// ---------------------------------------------------------------------------
// Élevage
// ---------------------------------------------------------------------------

const animalButtons: ButtonHandler = {
  namespace: 'animal',
  actions: ['open', 'page', 'collect_all', 'feed_all', 'pet_menu', 'noop'],
  lockKey: 'animal-action',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    switch (parsed.action) {
      case 'collect_all': {
        await interaction.deferUpdate();
        const result = await animalService.collect(context.player, { all: true });
        const embed = successEmbed(
          '🥚 Collecte',
          result.lines.map((line) => `${line.emoji} **${line.quantity}× ${line.itemName}**`).join('\n'),
        );
        appendTracking(embed, result.tracking);
        await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
        await interaction.editReply(await animalsView(context));
        return;
      }
      case 'feed_all': {
        await interaction.deferUpdate();
        const result = await animalService.feed(context.player, { all: true });
        await interaction.followUp({
          embeds: [successEmbed('🌾 Repas servi', `**${result.fed}** animal(aux) nourri(s).`)],
          flags: MessageFlags.Ephemeral,
        });
        await interaction.editReply(await animalsView(context));
        return;
      }
      case 'pet_menu': {
        const herd = await animalService.getHerd(context.player, context.now);
        const petable = herd.animals.filter((animal) => animal.canPet);
        if (petable.length === 0) {
          await replyEphemeral(interaction, {
            embeds: [
              baseEmbed({
                title: '🤍 Personne à câliner',
                description: 'Tous vos animaux ont déjà eu leur dose de tendresse récemment.',
                color: COLORS.info,
              }),
            ],
          });
          return;
        }
        const { select, selectRow } = await import('../../framework/ui');
        await replyEphemeral(interaction, {
          embeds: [baseEmbed({ title: '🤍 Qui voulez-vous caresser ?', color: COLORS.primary })],
          components: [
            selectRow(
              select({
                namespace: 'animal',
                action: 'pet',
                ownerId: interaction.user.id,
                placeholder: 'Choisissez un animal',
                choices: petable.slice(0, 25).map((animal) => ({
                  label: `${animal.nickname ?? animal.name} — bonheur ${animal.status.happiness}%`,
                  value: animal.id,
                  emoji: animal.emoji,
                })),
              }),
            ),
          ],
        });
        return;
      }
      default: {
        await interaction.deferUpdate();
        const page = parsed.action === 'page' ? paramInt(parsed, 0, { min: 1, fallback: 1 }) : 1;
        await interaction.editReply(await animalsView(context, page));
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Quêtes, succès, passe
// ---------------------------------------------------------------------------

const questButtons: ButtonHandler = {
  namespace: 'quest',
  actions: ['open', 'filter', 'claim_all'],
  lockKey: 'quest-action',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    if (parsed.action === 'claim_all') {
      await interaction.deferUpdate();
      const results = await progressionService.claimAllQuests(context.player);
      const totals = results.reduce(
        (accumulator, result) => ({
          coins: accumulator.coins + result.coins,
          gems: accumulator.gems + result.gems,
          xp: accumulator.xp + result.xp,
        }),
        { coins: 0, gems: 0, xp: 0 },
      );
      await interaction.followUp({
        embeds: [
          successEmbed(
            `🎁 ${results.length} récompense(s) perçue(s)`,
            `${formatCoins(totals.coins)} • ${totals.gems} 💎 • ${formatNumber(totals.xp)} ✨\n\n${results.map((result) => `• ${result.title}`).join('\n')}`,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      await interaction.editReply(await questsView(context));
      return;
    }

    await interaction.deferUpdate();
    const type = parsed.action === 'filter' ? paramString(parsed, 0) : '';
    await interaction.editReply(
      await questsView(context, (type || undefined) as 'daily' | 'weekly' | undefined),
    );
  },
};

const achievementButtons: ButtonHandler = {
  namespace: 'achv',
  actions: ['claim_all'],

  async execute(interaction: ButtonInteraction, _parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const achievements = await progressionService.listAchievements(context.player.id);
    const claimable = achievements.filter((entry) => entry.unlocked && !entry.claimed);

    let coins = 0;
    let gems = 0;
    const names: string[] = [];
    for (const achievement of claimable) {
      try {
        const result = await progressionService.claimAchievement(context.player, achievement.key);
        coins += result.coins;
        gems += result.gems;
        names.push(result.name);
      } catch {
        /* déjà réclamé entre-temps */
      }
    }

    await interaction.editReply({
      embeds: [
        successEmbed(
          `🏆 ${names.length} succès réclamé(s)`,
          names.length > 0
            ? `${formatCoins(coins)} • ${gems} 💎\n\n${names.map((name) => `• ${name}`).join('\n')}`
            : 'Aucune récompense en attente.',
        ),
      ],
    });
  },
};

const passButtons: ButtonHandler = {
  namespace: 'pass',
  actions: ['claim_all'],

  async execute(interaction: ButtonInteraction, _parsed, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const pass = await progressionService.getSeasonPass(context.player.id);
    if (!pass) {
      await interaction.editReply({ content: 'Aucun passe actif.' });
      return;
    }

    let coins = 0;
    let gems = 0;
    let claimed = 0;
    for (const tier of pass.tiers) {
      if (tier.tier > pass.tier || pass.claimedTiers.includes(tier.tier)) continue;
      try {
        const result = await progressionService.claimPassTier(context.player, tier.tier, false);
        coins += result.coins;
        gems += result.gems;
        claimed += 1;
      } catch {
        /* palier déjà réclamé */
      }
    }

    await interaction.editReply({
      embeds: [
        successEmbed(
          `🎟️ ${claimed} palier(s) réclamé(s)`,
          claimed > 0 ? `${formatCoins(coins)} • ${gems} 💎` : 'Aucun palier disponible.',
        ),
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// Artisanat et bâtiments
// ---------------------------------------------------------------------------

const craftButtons: ButtonHandler = {
  namespace: 'craft',
  actions: ['queue', 'collect_all', 'recipes'],
  lockKey: 'craft-action',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    if (parsed.action === 'collect_all') {
      await interaction.deferUpdate();
      const result = await craftService.collectProduction(context.player, { all: true });
      const embed = successEmbed(
        '📦 Production collectée',
        result.lines.map((line) => `${line.emoji} **${line.quantity}× ${line.itemName}**`).join('\n'),
      );
      appendTracking(embed, result.tracking);
      await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
      await interaction.editReply(await productionView(context));
      return;
    }

    if (parsed.action === 'recipes') {
      await replyEphemeral(interaction, {
        content: 'Utilisez `/recipes` pour la liste complète et `/craft` pour lancer une production.',
      });
      return;
    }

    await interaction.deferUpdate();
    await interaction.editReply(await productionView(context));
  },
};

const buildingButtons: ButtonHandler = {
  namespace: 'build',
  actions: ['open'],

  async execute(interaction: ButtonInteraction, _parsed, context): Promise<void> {
    await interaction.deferUpdate();
    await interaction.editReply(await buildingsView(context));
  },
};

// ---------------------------------------------------------------------------
// Coopérative
// ---------------------------------------------------------------------------

const coopButtons: ButtonHandler = {
  namespace: 'coop',
  actions: ['open', 'create', 'contribute', 'members', 'objectives'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    if (parsed.action === 'create') {
      await interaction.showModal(
        textModal({
          namespace: 'coop',
          action: 'create',
          ownerId: interaction.user.id,
          title: 'Créer une coopérative',
          fieldId: 'name',
          label: 'Nom de la coopérative',
          placeholder: 'Les Amis du Blé',
          maxLength: 32,
        }),
      );
      return;
    }

    if (parsed.action === 'contribute') {
      await interaction.showModal(
        quantityModal({
          namespace: 'coop',
          action: 'contribute',
          ownerId: interaction.user.id,
          title: 'Contribuer à la trésorerie',
          label: 'Montant en pièces',
          placeholder: 'Ex. 5000',
        }),
      );
      return;
    }

    await interaction.deferUpdate();
    await interaction.editReply(await coopView(context));
  },
};

// ---------------------------------------------------------------------------
// Aide, tutoriel, paramètres, prestige, social
// ---------------------------------------------------------------------------

const helpButtons: ButtonHandler = {
  namespace: 'help',
  actions: ['category'],
  checkOwner: false,

  async execute(interaction: ButtonInteraction, parsed): Promise<void> {
    await interaction.deferUpdate();
    await interaction.editReply({ embeds: [helpEmbed(paramString(parsed, 0) as never)] });
  },
};

const tutorialButtons: ButtonHandler = {
  namespace: 'tuto',
  actions: ['step'],
  requiresAccount: false,

  async execute(interaction: ButtonInteraction, parsed): Promise<void> {
    const index = paramInt(parsed, 0, { min: 1, max: TUTORIAL_STEPS.length, fallback: 1 });
    const step = TUTORIAL_STEPS[index - 1]!;

    await interaction.update({
      embeds: [
        baseEmbed({
          title: `🎓 ${step.title}`,
          description: step.body,
          color: COLORS.info,
          footer: 'Utilisez les boutons pour naviguer',
        }),
      ],
      components: [
        row(
          button({
            namespace: 'tuto',
            action: 'step',
            ownerId: interaction.user.id,
            params: [Math.max(1, index - 1)],
            emoji: '◀️',
            disabled: index <= 1,
          }),
          button({
            namespace: 'tuto',
            action: 'step',
            ownerId: interaction.user.id,
            params: [Math.min(TUTORIAL_STEPS.length, index + 1)],
            label: 'Suivant',
            emoji: '▶️',
            disabled: index >= TUTORIAL_STEPS.length,
          }),
          button({
            namespace: 'farm',
            action: 'refresh',
            ownerId: interaction.user.id,
            label: 'Ma ferme',
            emoji: '🌾',
          }),
        ),
      ],
    });
  },
};

const settingsButtons: ButtonHandler = {
  namespace: 'settings',
  actions: ['toggle'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    const field = paramString(parsed, 0);
    const allowed = ['notifyCrops', 'notifyAnimals', 'notifyEnergy', 'notifyMarket', 'dailyReminder', 'dmNotifications'];
    if (!allowed.includes(field)) {
      await replyEphemeral(interaction, { content: 'Paramètre inconnu.' });
      return;
    }

    const settings = await playerRepo.getSettings(context.player.id);
    const current = (settings as unknown as Record<string, boolean>)[field] ?? false;
    await playerRepo.updateSettings(context.player.id, { [field]: !current });

    await replyEphemeral(interaction, {
      embeds: [
        successEmbed(
          '⚙️ Paramètre mis à jour',
          `\`${field}\` est désormais **${!current ? 'activé' : 'désactivé'}**.` +
            (!settings?.dmNotifications && !current
              ? "\n\n⚠️ Activez aussi les **notifications par message privé** pour recevoir les alertes."
              : ''),
        ),
      ],
    });
  },
};

const prestigeButtons: ButtonHandler = {
  namespace: 'prestige',
  actions: ['confirm'],
  lockKey: 'prestige',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    if (paramString(parsed, 0) !== 'yes') {
      await interaction.update({
        embeds: [
          baseEmbed({
            title: '↩️ Renaissance annulée',
            description: 'Votre ferme reste intacte.',
            color: COLORS.neutral,
          }),
        ],
        components: [],
      });
      return;
    }

    await interaction.deferUpdate();
    const result = await miscService.doPrestige(context.player);
    await interaction.editReply({
      embeds: [
        successEmbed(
          `🌟 Renaissance ${result.newPrestige}`,
          [
            `Multiplicateur permanent : **×${result.multiplier.toFixed(2)}** sur le rendement et l'XP.`,
            `Parcelles conservées : **${result.plotsKept}**`,
            `Pièces conservées : **${formatCoins(result.coinsKept)}**`,
            `Points de prestige gagnés : **${result.pointsGained}**`,
            '',
            'Une nouvelle aventure commence. Bonne chance, fermier !',
          ].join('\n'),
        ),
      ],
      components: [],
    });
  },
};

const socialButtons: ButtonHandler = {
  namespace: 'social',
  actions: ['help', 'leaderboard'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    if (parsed.action === 'help') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const targetDiscordId = paramString(parsed, 0);
      await helpFarmer(interaction, context, targetDiscordId, `<@${targetDiscordId}>`);
      return;
    }

    await interaction.deferUpdate();
    await sendLeaderboard(
      interaction,
      context,
      paramString(parsed, 0, 'wealth') as miscService.LeaderboardType,
      'global',
    );
  },
};

const auctionButtons: ButtonHandler = {
  namespace: 'hdv',
  actions: ['page', 'noop'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferUpdate();
    if (parsed.action === 'noop') return;
    const page = paramInt(parsed, 0, { min: 1, fallback: 1 });
    const itemKey = paramString(parsed, 1, 'all');
    await interaction.editReply(
      await auctionListView(context, itemKey === 'all' ? undefined : itemKey, page),
    );
  },
};

const profileButtons: ButtonHandler = {
  namespace: 'profile',
  actions: ['stats'],

  async execute(interaction: ButtonInteraction, parsed): Promise<void> {
    await replyEphemeral(interaction, {
      content: `Utilisez \`/stats utilisateur:<@${paramString(parsed, 0)}>\` pour le détail complet.`,
    });
  },
};

// ---------------------------------------------------------------------------
// Langue
// ---------------------------------------------------------------------------

const langButtons: ButtonHandler = {
  namespace: 'lang',
  actions: ['set'],
  lockKey: 'lang-set',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    const requested = paramString(parsed, 0);
    if (!isSupported(requested)) {
      await replyEphemeral(interaction, { content: 'Langue inconnue. · Unknown language.' });
      return;
    }

    // `deferUpdate` puis `editReply` : on remplace le message existant plutôt
    // que d'en empiler un nouveau, et la confirmation arrive dans la langue
    // qui vient d'être choisie.
    await interaction.deferUpdate();
    await applyLocale(interaction, context, requested, { edit: true });
  },
};

export const handlers: ButtonHandler[] = [
  farmButtons,
  inventoryButtons,
  shopButtons,
  marketButtons,
  animalButtons,
  questButtons,
  achievementButtons,
  passButtons,
  craftButtons,
  buildingButtons,
  coopButtons,
  helpButtons,
  tutorialButtons,
  settingsButtons,
  prestigeButtons,
  socialButtons,
  auctionButtons,
  profileButtons,
  langButtons,
];
