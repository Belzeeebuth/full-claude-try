import { ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { CATEGORY_LABELS, type Command, type CommandCategory } from '../types';
import { COLORS, baseEmbed, button, row, select, selectRow } from '../framework/ui';
import { getRegistry } from '../framework/registry';
import { formatCoins } from '../utils/format';

/** Onboarding, tutoriel et aide. */

const start: Command = {
  category: 'demarrage',
  requiresAccount: false,
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('start')
    .setDescription('Créez votre ferme et commencez à jouer')
    .addStringOption((option) =>
      option
        .setName('code')
        .setDescription('Code de parrainage (bonus de départ)')
        .setRequired(false)
        .setMaxLength(12),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    // `buildContext` a déjà créé le compte si nécessaire (createIfMissing).
    if (!context.player.created) {
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: '🌾 Vous avez déjà une ferme !',
            description:
              'Utilisez `/ferme` pour la consulter, `/quetes` pour vos objectifs du jour, ou `/aide` si vous êtes perdu.',
            color: COLORS.info,
          }),
        ],
        components: [
          row(
            button({
              namespace: 'farm',
              action: 'refresh',
              ownerId: interaction.user.id,
              label: 'Voir ma ferme',
              emoji: '🌾',
              style: ButtonStyle.Success,
            }),
            button({
              namespace: 'quest',
              action: 'open',
              ownerId: interaction.user.id,
              label: 'Mes quêtes',
              emoji: '📋',
            }),
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      embeds: [
        baseEmbed({
          title: '🌾 Bienvenue à Val-Verdoyant !',
          description: [
            `Le maire vous confie une parcelle de terre en friche et **${formatCoins(context.player.coins)}**.`,
            '',
            'Votre objectif est simple : **faire pousser, récolter, vendre, réinvestir.**',
            '',
            '**Trois commandes pour commencer :**',
            '🌱 `/planter graine:Blé` — mettre une graine en terre',
            '🌾 `/ferme` — voir votre exploitation',
            '🧺 `/recolter` — encaisser votre travail',
            '',
            "Une question ? `/aide` répond à tout, et `/tutoriel` vous prend par la main.",
          ].join('\n'),
          color: COLORS.success,
          fields: [
            {
              name: '🎒 Sac de départ',
              value:
                '• 10× 🌾 graines de blé\n• 5× 🥕 graines de carotte\n• 2× 💩 engrais simple\n• 1× 🪣 arrosoir en bois\n• 10× 🌰 grain (pour vos futurs animaux)',
              inline: true,
            },
            {
              name: '🗺️ Votre domaine',
              value: `• ${context.balance.plots.startingUnlocked} parcelles (3×3)\n• 📦 Entrepôt niveau 1\n• 🏠 Maison niveau 1 (100 ⚡)`,
              inline: true,
            },
          ],
        }),
      ],
      components: [
        row(
          button({
            namespace: 'tuto',
            action: 'step',
            ownerId: interaction.user.id,
            params: [1],
            label: 'Lancer le tutoriel',
            emoji: '🎓',
            style: ButtonStyle.Primary,
          }),
          button({
            namespace: 'farm',
            action: 'refresh',
            ownerId: interaction.user.id,
            label: 'Voir ma ferme',
            emoji: '🌾',
            style: ButtonStyle.Success,
          }),
          button({
            namespace: 'farm',
            action: 'plant_menu',
            ownerId: interaction.user.id,
            label: 'Planter maintenant',
            emoji: '🌱',
          }),
        ),
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// /tutoriel
// ---------------------------------------------------------------------------

export const TUTORIAL_STEPS = [
  {
    title: '1/6 — Planter',
    body:
      'Tout commence par une graine.\n\n`/planter graine:Blé`\n\nSans numéro de parcelle, le bot remplit automatiquement vos parcelles vides. ' +
      'Ajoutez `quantité:9` pour tout planter d\'un coup.',
  },
  {
    title: '2/6 — Arroser',
    body:
      'Chaque culture attend un ou plusieurs arrosages pendant sa croissance.\n\n`/arroser`\n\n' +
      'Un arrosage manqué coûte 8 % de rendement (jusqu\'à −40 %). Les jours de pluie, c\'est gratuit !',
  },
  {
    title: '3/6 — Récolter',
    body:
      "Quand la culture est prête, encaissez :\n\n`/recolter`\n\n" +
      'Votre récolte peut sortir en qualité **argent**, **or** ou **iridium** — jusqu\'à ×3 sur le prix. ' +
      'Un bon sol et un engrais de qualité augmentent vos chances.',
  },
  {
    title: '4/6 — Vendre',
    body:
      'Le village achète tout :\n\n`/vendre objet:Blé quantité:tout`\n\n' +
      'Les prix bougent chaque heure selon ce que vendent les autres joueurs : consultez `/marche` avant de brader.',
  },
  {
    title: '5/6 — Réinvestir',
    body:
      'Vos pièces servent à grandir :\n\n' +
      '• `/acheter-parcelle` — plus de terrain\n' +
      '• `/boutique` — graines, engrais, outils\n' +
      '• `/batiments` — poulailler, moulin, entrepôt\n' +
      '• `/acheter-animal` — production passive',
  },
  {
    title: '6/6 — Progresser',
    body:
      'Chaque jour :\n\n' +
      '• `/daily` — récompense quotidienne et série\n' +
      '• `/quetes` — 4 quêtes journalières + 3 hebdomadaires\n' +
      '• `/coop` — rejoignez une coopérative pour des bonus permanents\n\n' +
      'Bonne chance, fermier ! 🌾',
  },
] as const;

const tutoriel: Command = {
  category: 'demarrage',
  requiresAccount: false,
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('tutoriel')
    .setDescription('Tutoriel pas à pas pour bien démarrer')
    .toJSON(),

  async execute(interaction): Promise<void> {
    const step = TUTORIAL_STEPS[0]!;
    await interaction.reply({
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
            params: [1],
            emoji: '◀️',
            disabled: true,
          }),
          button({
            namespace: 'tuto',
            action: 'step',
            ownerId: interaction.user.id,
            params: [2],
            label: 'Suivant',
            emoji: '▶️',
            style: ButtonStyle.Primary,
          }),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

// ---------------------------------------------------------------------------
// /aide
// ---------------------------------------------------------------------------

export function helpEmbed(category?: CommandCategory) {
  const registry = getRegistry();
  const commandsByCategory = new Map<CommandCategory, string[]>();

  for (const command of registry.commands.values()) {
    if (command.adminOnly && category !== 'admin') continue;
    const list = commandsByCategory.get(command.category) ?? [];
    const description =
      'description' in command.data && typeof command.data.description === 'string'
        ? command.data.description
        : '';
    list.push(`\`/${command.data.name}\` — ${description}`);
    commandsByCategory.set(command.category, list);
  }

  if (category) {
    const meta = CATEGORY_LABELS[category];
    return baseEmbed({
      title: `${meta.emoji} ${meta.label}`,
      description: `${meta.description}\n\n${(commandsByCategory.get(category) ?? []).sort().join('\n')}`,
      color: COLORS.primary,
    });
  }

  return baseEmbed({
    title: '🌾 Aide de Harvester',
    description:
      'Harvester est un jeu de ferme : plantez, élevez, transformez, vendez, progressez.\n' +
      'Choisissez une catégorie ci-dessous pour voir les commandes détaillées.',
    color: COLORS.primary,
    fields: [
      {
        name: '🚀 Pour bien démarrer',
        value: '`/start` → `/planter` → `/arroser` → `/recolter` → `/vendre`',
      },
      {
        name: '📚 Catégories',
        value: Object.entries(CATEGORY_LABELS)
          .filter(([key]) => key !== 'admin')
          .map(([key, meta]) => `${meta.emoji} **${meta.label}** — ${commandsByCategory.get(key as CommandCategory)?.length ?? 0} commandes`)
          .join('\n'),
      },
      {
        name: '💡 Le saviez-vous ?',
        value:
          "• La météo est commune à tout le village : les jours de pluie, l'arrosage est gratuit.\n" +
          '• Les prix du marché baissent quand tout le monde vend la même chose.\n' +
          "• Une coopérative accorde des bonus permanents à tous ses membres.",
      },
    ],
  });
}

const aide: Command = {
  category: 'demarrage',
  requiresAccount: false,
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('aide')
    .setDescription("Menu d'aide interactif")
    .addStringOption((option) =>
      option
        .setName('catégorie')
        .setDescription('Aller directement à une catégorie')
        .addChoices(
          ...Object.entries(CATEGORY_LABELS)
            .filter(([key]) => key !== 'admin')
            .map(([key, meta]) => ({ name: `${meta.emoji} ${meta.label}`, value: key })),
        ),
    )
    .toJSON(),

  async execute(interaction): Promise<void> {
    const category = interaction.options.getString('catégorie') as CommandCategory | null;
    await interaction.reply({
      embeds: [helpEmbed(category ?? undefined)],
      components: [
        selectRow(
          select({
            namespace: 'help',
            action: 'category',
            ownerId: interaction.user.id,
            placeholder: 'Choisissez une catégorie d\'aide',
            choices: Object.entries(CATEGORY_LABELS)
              .filter(([key]) => key !== 'admin')
              .map(([key, meta]) => ({
                label: meta.label,
                value: key,
                emoji: meta.emoji,
                description: meta.description,
                default: category === key,
              })),
          }),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const commands: Command[] = [start, tutoriel, aide];
