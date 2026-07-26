import {
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type InteractionEditReplyOptions,
  type User,
} from 'discord.js';
import { COLORS, baseEmbed, button, row, successEmbed } from '../framework/ui';
import { coopView, farmView } from '../framework/views';
import { renderLeaderboardImage } from '../render';
import * as coopService from '../services/coop.service';
import * as farmService from '../services/farm.service';
import * as miscService from '../services/misc.service';
import * as playerRepo from '../repositories/player.repo';
import { gameError } from '../utils/errors';
import { formatCoins, formatCompact, formatNumber, progressBar, truncate } from '../utils/format';
import type { Command, CommandContext } from '../types';

/** Commandes sociales : coopératives, classements, visites, parrainage. */

// ---------------------------------------------------------------------------
// /coop
// ---------------------------------------------------------------------------

const coop: Command = {
  category: 'social',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('coop')
    .setDescription('Gestion de votre coopérative')
    .addSubcommand((sub) =>
      sub
        .setName('creer')
        .setDescription('Créer une coopérative')
        .addStringOption((option) =>
          option.setName('nom').setDescription('Nom (3-32 caractères)').setRequired(true).setMaxLength(32),
        )
        .addStringOption((option) =>
          option.setName('tag').setDescription('Étiquette (2-5 caractères)').setRequired(true).setMaxLength(5),
        )
        .addStringOption((option) =>
          option.setName('description').setDescription('Présentation de la coopérative').setMaxLength(200),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('rejoindre')
        .setDescription('Rejoindre une coopérative publique')
        .addStringOption((option) =>
          option.setName('nom').setDescription('Nom ou étiquette').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('quitter').setDescription('Quitter votre coopérative'))
    .addSubcommand((sub) => sub.setName('info').setDescription('Informations sur votre coopérative'))
    .addSubcommand((sub) => sub.setName('membres').setDescription('Liste des membres'))
    .addSubcommand((sub) =>
      sub
        .setName('inviter')
        .setDescription('Inviter un joueur')
        .addUserOption((option) => option.setName('utilisateur').setDescription('Le joueur').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('expulser')
        .setDescription('Expulser un membre')
        .addUserOption((option) => option.setName('utilisateur').setDescription('Le membre').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('promouvoir')
        .setDescription('Changer le rang d\'un membre')
        .addUserOption((option) => option.setName('utilisateur').setDescription('Le membre').setRequired(true))
        .addStringOption((option) =>
          option
            .setName('rang')
            .setDescription('Nouveau rang')
            .setRequired(true)
            .addChoices(
              { name: 'Chef (transmet la direction)', value: 'owner' },
              { name: 'Officier', value: 'officer' },
              { name: 'Membre', value: 'member' },
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('tresorerie').setDescription('État de la trésorerie'))
    .addSubcommand((sub) =>
      sub
        .setName('contribuer')
        .setDescription('Verser des pièces à la trésorerie')
        .addIntegerOption((option) =>
          option.setName('montant').setDescription('Montant en pièces').setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName('objectifs').setDescription('Objectifs hebdomadaires'))
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply();

    switch (sub) {
      case 'creer': {
        const info = await coopService.createCoop(context.player, {
          name: interaction.options.getString('nom', true),
          tag: interaction.options.getString('tag', true),
          description: interaction.options.getString('description') ?? undefined,
        });
        await interaction.editReply({
          embeds: [
            successEmbed(
              `${info.emblem} ${info.name} [${info.tag}] fondée !`,
              `Coût : ${formatCoins(context.balance.coop.creationCostCoins)}\n` +
                `Invitez vos amis avec \`/coop inviter\` et remplissez les objectifs hebdomadaires ensemble.`,
            ),
          ],
        });
        break;
      }
      case 'rejoindre': {
        const info = await coopService.joinCoop(context.player, interaction.options.getString('nom', true));
        await interaction.editReply({
          embeds: [
            successEmbed(
              `Bienvenue chez ${info.emblem} ${info.name} !`,
              `Vous bénéficiez immédiatement des bonus de niveau ${info.level}.`,
            ),
          ],
        });
        break;
      }
      case 'quitter': {
        const result = await coopService.leaveCoop(context.player);
        await interaction.editReply({
          embeds: [
            successEmbed(
              'Départ enregistré',
              result.dissolved
                ? `**${result.coopName}** a été dissoute (vous étiez le dernier membre).`
                : `Vous avez quitté **${result.coopName}**.`,
            ),
          ],
        });
        break;
      }
      case 'membres': {
        const membership = await coopService.requireMembership(context.player.id);
        const members = await coopService.listMembers(membership.coop.id);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: `👥 Membres de ${membership.coop.name}`,
              description: members
                .map(
                  (member, index) =>
                    `${index + 1}. **${member.username}** — ${coopService.ROLE_LABELS[member.member.role as 'owner' | 'officer' | 'member']} • niv. ${member.level}\n     Contribution semaine : ${formatCoins(member.member.weeklyContribution, true)} • totale : ${formatCoins(member.member.contributedCoins, true)}`,
                )
                .join('\n'),
              color: COLORS.primary,
              footer: `${members.length}/${membership.coop.memberLimit} membres`,
            }),
          ],
        });
        break;
      }
      case 'inviter': {
        const target = interaction.options.getUser('utilisateur', true);
        const targetUser = await playerRepo.findUserByDiscordId(target.id);
        if (!targetUser) throw gameError('not_found', "Ce joueur n'a pas encore de ferme.");
        const result = await coopService.inviteMember(context.player, targetUser.id);
        await interaction.editReply({
          embeds: [successEmbed('Invitation acceptée', `${target} a rejoint **${result.coopName}**.`)],
        });
        break;
      }
      case 'expulser': {
        const target = interaction.options.getUser('utilisateur', true);
        const targetUser = await playerRepo.findUserByDiscordId(target.id);
        if (!targetUser) throw gameError('not_found', 'Joueur introuvable.');
        const result = await coopService.kickMember(context.player, targetUser.id);
        await interaction.editReply({
          embeds: [successEmbed('Membre expulsé', `${target} ne fait plus partie de **${result.coopName}**.`)],
        });
        break;
      }
      case 'promouvoir': {
        const target = interaction.options.getUser('utilisateur', true);
        const role = interaction.options.getString('rang', true) as 'owner' | 'officer' | 'member';
        const targetUser = await playerRepo.findUserByDiscordId(target.id);
        if (!targetUser) throw gameError('not_found', 'Joueur introuvable.');
        const result = await coopService.promoteMember(context.player, targetUser.id, role);
        await interaction.editReply({
          embeds: [successEmbed('Rang modifié', `${target} est désormais **${result.roleLabel}**.`)],
        });
        break;
      }
      case 'contribuer': {
        const amount = interaction.options.getInteger('montant', true);
        const result = await coopService.contribute(context.player, amount);
        await interaction.editReply({
          embeds: [
            successEmbed(
              '💰 Contribution',
              `${formatCoins(amount)} versés.\nTrésorerie : **${formatCoins(result.treasury)}**\n` +
                `+${formatNumber(result.coopXp)} XP de coopérative${result.levelsGained > 0 ? ` — 🎉 **niveau ${result.level} atteint !**` : ''}`,
            ),
          ],
        });
        break;
      }
      case 'tresorerie': {
        const membership = await coopService.requireMembership(context.player.id);
        const info = await coopService.getCoopInfo(membership.coop.id, context.player.id);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: `💰 Trésorerie de ${info.name}`,
              description: `**${formatCoins(info.treasury)}**\n\nSeuls le chef et les officiers peuvent retirer.`,
              color: COLORS.gold,
            }),
          ],
          components: [
            row(
              button({
                namespace: 'coop',
                action: 'contribute',
                ownerId: context.player.discordId,
                label: 'Contribuer',
                emoji: '💰',
                style: ButtonStyle.Success,
              }),
            ),
          ],
        });
        break;
      }
      case 'objectifs': {
        const membership = await coopService.requireMembership(context.player.id);
        const objectives = await coopService.listObjectives(membership.coop.id, context.now);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: `🎯 Objectifs de ${membership.coop.name}`,
              description:
                objectives
                  .map(
                    (objective) =>
                      `**${objective.title}** ${objective.status === 'completed' ? '✅' : ''}\n${objective.description}\n${progressBar(Number(objective.progress), Number(objective.target), 12)} ${formatCompact(Number(objective.progress))}/${formatCompact(Number(objective.target))}\n🎁 ${formatCoins(objective.rewardCoins)} partagés + ${objective.rewardGems} 💎 chacun`,
                  )
                  .join('\n\n') || 'Aucun objectif cette semaine.',
              color: COLORS.primary,
            }),
          ],
        });
        break;
      }
      default: {
        await interaction.editReply(await coopView(context));
      }
    }
  },
};

// ---------------------------------------------------------------------------
// /classement
// ---------------------------------------------------------------------------

const classement: Command = {
  category: 'social',
  cooldown: { seconds: 10, bucket: 'classement' },
  data: new SlashCommandBuilder()
    .setName('classement')
    .setDescription('Classements des fermiers')
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('Type de classement')
        .addChoices(
          { name: '🪙 Richesse', value: 'wealth' },
          { name: '⭐ Expérience', value: 'level' },
          { name: '🌾 Récoltes', value: 'harvests' },
          { name: '🐄 Élevage', value: 'animals' },
          { name: '🛠️ Artisanat', value: 'crafts' },
          { name: '📈 XP de la semaine', value: 'weekly_xp' },
          { name: '🤝 Coopératives', value: 'coop_score' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('portée')
        .setDescription('Étendue du classement')
        .addChoices(
          { name: '🌍 Global', value: 'global' },
          { name: '🏠 Ce serveur', value: 'discord' },
          { name: '🤝 Ma coopérative', value: 'coop' },
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const type = (interaction.options.getString('type') ?? 'wealth') as miscService.LeaderboardType;
    const scope = (interaction.options.getString('portée') ?? 'global') as 'global' | 'discord' | 'coop';

    await sendLeaderboard(interaction, context, type, scope);
  },
};

/** Interface minimale nécessaire pour répondre : commande ou composant. */
export interface Replyable {
  editReply: (payload: InteractionEditReplyOptions) => Promise<unknown>;
}

export async function sendLeaderboard(
  interaction: Replyable,
  context: CommandContext,
  type: miscService.LeaderboardType,
  scope: 'global' | 'discord' | 'coop',
): Promise<void> {
  const meta = miscService.LEADERBOARD_LABELS[type];
  const board = await miscService.getLeaderboard(type, {
    scope,
    discordGuildId: context.discordGuildId,
    coopId: context.player.coopId ?? undefined,
    limit: 10,
  });
  const viewerRank = await miscService.getUserRank(type, context.player.id);

  const scopeLabel =
    scope === 'discord' ? 'Ce serveur' : scope === 'coop' ? 'Ma coopérative' : 'Global';

  const image = await renderLeaderboardImage({
    title: meta.label,
    emoji: meta.emoji,
    unit: meta.unit,
    scopeLabel,
    entries: board.rows.map((entry) => ({
      rank: entry.rank,
      name: entry.name,
      score: entry.score,
      extra: entry.extra,
      isViewer: 'userId' in entry ? entry.userId === context.player.id : false,
    })),
    viewer: viewerRank,
  });

  const embed = baseEmbed({
    title: `${meta.emoji} Classement — ${meta.label}`,
    description:
      board.rows
        .map(
          (entry) =>
            `${entry.rank === 1 ? '🥇' : entry.rank === 2 ? '🥈' : entry.rank === 3 ? '🥉' : `\`#${entry.rank}\``} **${entry.name}** — ${formatCompact(entry.score)} ${meta.unit}`,
        )
        .join('\n') || 'Aucun classement disponible.',
    color: COLORS.gold,
    image: image.fileName ? `attachment://${image.fileName}` : undefined,
    footer: viewerRank ? `Votre rang : #${viewerRank.rank} • ${scopeLabel}` : scopeLabel,
  });

  await interaction.editReply({
    embeds: [embed],
    files: image.attachment ? [image.attachment] : [],
  });
}

// ---------------------------------------------------------------------------
// /visiter, /aider
// ---------------------------------------------------------------------------

const visiter: Command = {
  category: 'social',
  cooldown: { seconds: 30, bucket: 'visit' },
  data: new SlashCommandBuilder()
    .setName('visiter')
    .setDescription('Visite la ferme d\'un autre joueur')
    .addUserOption((option) =>
      option.setName('utilisateur').setDescription('Le fermier à visiter').setRequired(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    await visitFarm(interaction, context, interaction.options.getUser('utilisateur', true));
  },
};

/** Affiche la ferme d'un autre joueur et enregistre la visite. */
export async function visitFarm(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
  target: User,
): Promise<void> {
  if (target.bot) throw gameError('target_invalid', 'Les robots ne cultivent pas.');

  const bundle = await playerRepo.loadPlayerBundle(target.id);
  if (!bundle) throw gameError('not_found', `${target.displayName} n'a pas encore de ferme.`);
  if (bundle.settings.privacy === 'private' && target.id !== interaction.user.id) {
    throw gameError('privacy_blocked', `${target.displayName} a rendu sa ferme privée.`);
  }

  const visitorContext: CommandContext = {
    ...context,
    player: {
      ...context.player,
      id: bundle.user.id,
      farmId: bundle.farm.id,
      level: bundle.user.level,
      coins: bundle.user.coins,
      gems: bundle.user.gems,
      prestige: bundle.user.prestige,
      xp: bundle.user.xp,
      username: bundle.user.displayName ?? bundle.user.username,
    },
  };

  const view = await farmView(visitorContext, {
    targetName: target.displayName,
    avatarUrl: target.displayAvatarURL({ extension: 'png', size: 128 }),
    readOnly: true,
  });

  const reward =
    target.id === interaction.user.id
      ? { rewarded: false, coins: 0, xp: 0 }
      : await miscService.recordVisit(
          context.player,
          { id: bundle.user.id, farmId: bundle.farm.id },
          false,
          0,
        );

  const embed = view.embeds?.[0] as EmbedBuilder | undefined;
  if (embed && reward.rewarded) {
    embed.setFooter({
      text: `Visite récompensée : +${reward.coins} 🪙 et +${reward.xp} XP`,
    });
  }

  await interaction.editReply({
    embeds: view.embeds ?? [],
    files: view.files ?? [],
    components:
      target.id === interaction.user.id
        ? []
        : [
            row(
              button({
                namespace: 'social',
                action: 'help',
                ownerId: interaction.user.id,
                params: [target.id],
                label: 'Aider (arroser ses parcelles)',
                emoji: '🤝',
                style: ButtonStyle.Success,
              }),
            ),
          ],
  });
}

const aider: Command = {
  category: 'social',
  cooldown: { seconds: 60, bucket: 'help' },
  data: new SlashCommandBuilder()
    .setName('aider')
    .setDescription('Aide un fermier en arrosant ses parcelles (vous gagnez tous les deux)')
    .addUserOption((option) =>
      option.setName('utilisateur').setDescription('Le fermier à aider').setRequired(true),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();
    const target = interaction.options.getUser('utilisateur', true);
    await helpFarmer(interaction, context, target.id, target.displayName);
  },
};

export async function helpFarmer(
  interaction: Replyable,
  context: CommandContext,
  targetDiscordId: string,
  targetName: string,
): Promise<void> {
  if (targetDiscordId === context.player.discordId) {
    throw gameError('target_invalid', 'Vous ne pouvez pas vous aider vous-même.');
  }

  const bundle = await playerRepo.loadPlayerBundle(targetDiscordId);
  if (!bundle) throw gameError('not_found', `${targetName} n'a pas encore de ferme.`);

  const helped = await farmService.helpFarmer(context.player, bundle.farm.id, bundle.user.id);
  const reward = await miscService.recordVisit(
    context.player,
    { id: bundle.user.id, farmId: bundle.farm.id },
    true,
    helped.plotsWatered,
  );

  await interaction.editReply({
    embeds: [
      successEmbed(
        '🤝 Coup de main donné',
        [
          `Vous avez arrosé **${helped.plotsWatered}** parcelle(s) de ${targetName}.`,
          reward.rewarded
            ? `Récompense : ${formatCoins(reward.coins)} et +${reward.xp} ✨\n${targetName} reçoit également un petit bonus.`
            : `*Vous avez déjà aidé ${targetName} aujourd'hui : pas de récompense supplémentaire.*`,
          `Les cultures arrosées par un ami donnent un **bonus de rendement** à leur propriétaire.`,
        ].join('\n'),
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// /parrainage
// ---------------------------------------------------------------------------

const parrainage: Command = {
  category: 'social',
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('parrainage')
    .setDescription('Votre code de parrainage et vos récompenses')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const status = await miscService.referralStatus(context.player.id);
    await interaction.reply({
      embeds: [
        baseEmbed({
          title: '🎟️ Parrainage',
          description: [
            `Votre code : **\`${status.code}\`**`,
            '',
            `Un nouveau joueur qui lance \`/start code:${status.code}\` reçoit **${formatCoins(context.balance.social.referredStartBonusCoins)}** de bonus de départ.`,
            `Lorsqu'il atteint le **niveau ${status.qualifyLevel}**, vous recevez **${formatCoins(status.rewardCoins)}** et **${status.rewardGems} 💎**.`,
            '',
            status.referredBy ? '✅ Vous avez été parrainé — merci de faire vivre le village !' : '',
          ]
            .filter(Boolean)
            .join('\n'),
          color: COLORS.info,
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const commands: Command[] = [coop, classement, visiter, aider, parrainage];
export { truncate };
