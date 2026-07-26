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
    .setDescription('Create your farm and start playing')
    .addStringOption((option) =>
      option
        .setName('code')
        .setDescription('Referral code (starting bonus)')
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
            title: '🌾 You already have a farm!',
            description:
              'Use `/farm` to check on it, `/quests` for today\'s goals, or `/help` if you are lost.',
            color: COLORS.info,
          }),
        ],
        components: [
          row(
            button({
              namespace: 'farm',
              action: 'refresh',
              ownerId: interaction.user.id,
              label: 'View my farm',
              emoji: '🌾',
              style: ButtonStyle.Success,
            }),
            button({
              namespace: 'quest',
              action: 'open',
              ownerId: interaction.user.id,
              label: 'My quests',
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
          title: '🌾 Welcome to Greenvale!',
          description: [
            `The mayor grants you a patch of fallow land and **${formatCoins(context.player.coins)}**.`,
            '',
            'Your goal is simple: **grow, harvest, sell, reinvest.**',
            '',
            '**Three commands to get going:**',
            '🌱 `/plant seed:Wheat` — sow a seed',
            '🌾 `/farm` — view your holding',
            '🧺 `/harvest` — cash in your work',
            '',
            "Stuck? `/help` answers everything, and `/tutorial` walks you through it.",
          ].join('\n'),
          color: COLORS.success,
          fields: [
            {
              name: '🎒 Starter bag',
              value:
                '• 10× 🌾 wheat seeds\n• 5× 🥕 carrot seeds\n• 2× 💩 basic fertilizer\n• 1× 🪣 wooden watering can\n• 10× 🌰 grain (for your future animals)',
              inline: true,
            },
            {
              name: '🗺️ Your estate',
              value: `• ${context.balance.plots.startingUnlocked} plots (3×3)\n• 📦 Warehouse level 1\n• 🏠 House level 1 (100 ⚡)`,
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
            label: 'Start the tutorial',
            emoji: '🎓',
            style: ButtonStyle.Primary,
          }),
          button({
            namespace: 'farm',
            action: 'refresh',
            ownerId: interaction.user.id,
            label: 'View my farm',
            emoji: '🌾',
            style: ButtonStyle.Success,
          }),
          button({
            namespace: 'farm',
            action: 'plant_menu',
            ownerId: interaction.user.id,
            label: 'Plant now',
            emoji: '🌱',
          }),
        ),
      ],
    });
  },
};

// ---------------------------------------------------------------------------
// /tutorial
// ---------------------------------------------------------------------------

export const TUTORIAL_STEPS = [
  {
    title: '1/6 — Planting',
    body:
      'Everything starts with a seed.\n\n`/plant seed:Wheat`\n\nWithout a plot number, the bot fills your empty plots automatically. ' +
      'Add `quantity:9` to sow them all at once.',
  },
  {
    title: '2/6 — Watering',
    body:
      'Every crop expects one or more waterings while it grows.\n\n`/water`\n\n' +
      'A missed watering costs 8% of the yield (up to −40%). On rainy days it is free!',
  },
  {
    title: '3/6 — Harvesting',
    body:
      "When a crop is ready, cash it in:\n\n`/harvest`\n\n" +
      'Your harvest can come out **silver**, **gold** or **iridium** — up to ×3 on the price. ' +
      'Good soil and quality fertilizer improve your odds.',
  },
  {
    title: '4/6 — Selling',
    body:
      'The village buys everything:\n\n`/sell item:Wheat quantity:all`\n\n' +
      'Prices move every hour with what other players sell: check `/market` before dumping stock.',
  },
  {
    title: '5/6 — Reinvesting',
    body:
      'Your coins are there to grow:\n\n' +
      '• `/buy-plot` — more land\n' +
      '• `/shop` — seeds, fertilizer, tools\n' +
      '• `/buildings` — coop, mill, warehouse\n' +
      '• `/buy-animal` — passive production',
  },
  {
    title: '6/6 — Progressing',
    body:
      'Every day:\n\n' +
      '• `/daily` — daily reward and streak\n' +
      '• `/quests` — 4 daily quests + 3 weekly\n' +
      '• `/coop` — join a co-op for permanent bonuses\n\n' +
      'Good luck, farmer! 🌾',
  },
] as const;

const tutoriel: Command = {
  category: 'demarrage',
  requiresAccount: false,
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('tutorial')
    .setDescription('Step-by-step tutorial to get started')
    .toJSON(),

  async execute(interaction): Promise<void> {
    const step = TUTORIAL_STEPS[0]!;
    await interaction.reply({
      embeds: [
        baseEmbed({
          title: `🎓 ${step.title}`,
          description: step.body,
          color: COLORS.info,
          footer: 'Use the buttons to navigate',
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
            label: 'Next',
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
// /help
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
    title: '🌾 Harvester help',
    description:
      'Harvester is a farming game: plant, raise, process, sell, progress.\n' +
      'Pick a category below to see the detailed commands.',
    color: COLORS.primary,
    fields: [
      {
        name: '🚀 Getting going',
        value: '`/start` → `/plant` → `/water` → `/harvest` → `/sell`',
      },
      {
        name: '📚 Categories',
        value: Object.entries(CATEGORY_LABELS)
          .filter(([key]) => key !== 'admin')
          .map(([key, meta]) => `${meta.emoji} **${meta.label}** — ${commandsByCategory.get(key as CommandCategory)?.length ?? 0} commands`)
          .join('\n'),
      },
      {
        name: '💡 Did you know?',
        value:
          "• Weather is shared by the whole village: on rainy days, watering is free.\n" +
          '• Market prices fall when everyone sells the same thing.\n' +
          "• A co-op grants permanent bonuses to all its members.",
      },
    ],
  });
}

const aide: Command = {
  category: 'demarrage',
  requiresAccount: false,
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription("Interactive help menu")
    .addStringOption((option) =>
      option
        .setName('category')
        .setDescription('Jump straight to a category')
        .addChoices(
          ...Object.entries(CATEGORY_LABELS)
            .filter(([key]) => key !== 'admin')
            .map(([key, meta]) => ({ name: `${meta.emoji} ${meta.label}`, value: key })),
        ),
    )
    .toJSON(),

  async execute(interaction): Promise<void> {
    const category = interaction.options.getString('category') as CommandCategory | null;
    await interaction.reply({
      embeds: [helpEmbed(category ?? undefined)],
      components: [
        selectRow(
          select({
            namespace: 'help',
            action: 'category',
            ownerId: interaction.user.id,
            placeholder: 'Pick a help category',
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
