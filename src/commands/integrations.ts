import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, errorEmbed, successEmbed } from '../framework/ui';
import * as apiService from '../services/api.service';
import * as webhookService from '../services/webhook.service';
import { discordTimestamp, truncate } from '../utils/format';
import type { Command } from '../types';

/**
 * `/apikey` et `/webhook` — intégrations tierces (v3.2, API REST publique).
 *
 * Toutes les réponses sont éphémères : une clé d'API ou un secret de signature
 * de webhook n'a rien à faire dans un salon partagé, même une fois révoquée.
 */

const apikey: Command = {
  category: 'demarrage',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('apikey')
    .setDescription('Manage your personal API keys')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create a new API key')
        .addStringOption((option) =>
          option.setName('label').setDescription('Name to recognise this key later').setMaxLength(48),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List your active API keys'))
    .addSubcommand((sub) =>
      sub
        .setName('revoke')
        .setDescription('Revoke an API key')
        .addStringOption((option) =>
          option.setName('prefix').setDescription('Key prefix, shown by /apikey list').setRequired(true),
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const t = context.t;

    switch (sub) {
      case 'create': {
        const label = interaction.options.getString('label') ?? 'default';
        const created = await apiService.createApiKey(context.player, label);
        await interaction.editReply({
          embeds: [
            successEmbed(
              t('integrations.apikey_created_title'),
              [
                t('integrations.apikey_created_body', { key: created.rawKey }),
                '',
                t('integrations.apikey_created_warning'),
              ].join('\n'),
            ),
          ],
        });
        break;
      }
      case 'list': {
        const keys = await apiService.listApiKeys(context.player);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: t('integrations.apikey_list_title'),
              description:
                keys
                  .map((key) =>
                    t('integrations.apikey_list_line', {
                      prefix: key.keyPrefix,
                      label: key.label,
                      created: discordTimestamp(key.createdAt, 'R'),
                      lastUsed: key.lastUsedAt
                        ? discordTimestamp(key.lastUsedAt, 'R')
                        : t('integrations.never'),
                    }),
                  )
                  .join('\n') || t('integrations.apikey_list_empty'),
              color: COLORS.info,
            }),
          ],
        });
        break;
      }
      case 'revoke': {
        const prefix = interaction.options.getString('prefix', true);
        await apiService.revokeApiKey(context.player, prefix);
        await interaction.editReply({
          embeds: [
            successEmbed(
              t('integrations.apikey_revoked_title'),
              t('integrations.apikey_revoked_body', { prefix }),
            ),
          ],
        });
        break;
      }
    }
  },
};

const webhook: Command = {
  category: 'demarrage',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('webhook')
    .setDescription('Manage your outgoing webhooks')
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Register a new webhook endpoint')
        .addStringOption((option) =>
          option
            .setName('url')
            .setDescription('HTTPS endpoint that will receive events')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('events')
            .setDescription('Events to subscribe to')
            .setRequired(true)
            .addChoices(
              { name: 'Crop ready', value: 'crop_ready' },
              { name: 'Auction won', value: 'auction_won' },
              { name: 'All events', value: 'all' },
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List your webhooks'))
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Remove a webhook')
        .addStringOption((option) =>
          option.setName('id').setDescription('Webhook ID, shown by /webhook list').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('test')
        .setDescription('Send a test ping to a webhook')
        .addStringOption((option) =>
          option.setName('id').setDescription('Webhook ID, shown by /webhook list').setRequired(true),
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const t = context.t;

    switch (sub) {
      case 'create': {
        const url = interaction.options.getString('url', true);
        const raw = interaction.options.getString('events', true);
        const events = raw === 'all' ? [...webhookService.WEBHOOK_EVENT_TYPES] : [raw];
        const created = await webhookService.subscribe(context.player, url, events);
        await interaction.editReply({
          embeds: [
            successEmbed(
              t('integrations.webhook_created_title'),
              [
                t('integrations.webhook_created_body', { id: created.id }),
                t('integrations.webhook_created_secret', { secret: created.secret }),
                '',
                t('integrations.webhook_created_warning'),
              ].join('\n'),
            ),
          ],
        });
        break;
      }
      case 'list': {
        const subscriptions = await webhookService.listSubscriptions(context.player);
        await interaction.editReply({
          embeds: [
            baseEmbed({
              title: t('integrations.webhook_list_title'),
              description:
                subscriptions
                  .map((subscription) =>
                    t('integrations.webhook_list_line', {
                      id: subscription.id,
                      url: truncate(subscription.url, 60),
                      events: (subscription.events as string[]).join(', '),
                      status: subscription.enabled
                        ? t('integrations.status_active')
                        : t('integrations.status_disabled'),
                    }),
                  )
                  .join('\n') || t('integrations.webhook_list_empty'),
              color: COLORS.info,
            }),
          ],
        });
        break;
      }
      case 'delete': {
        const id = interaction.options.getString('id', true);
        await webhookService.unsubscribe(context.player, id);
        await interaction.editReply({
          embeds: [
            successEmbed(t('integrations.webhook_deleted_title'), t('integrations.webhook_deleted_body')),
          ],
        });
        break;
      }
      case 'test': {
        const id = interaction.options.getString('id', true);
        const outcome = await webhookService.sendTestPing(context.player, id);
        await interaction.editReply({
          embeds: [
            outcome.ok
              ? successEmbed(
                  t('integrations.webhook_test_ok_title'),
                  t('integrations.webhook_test_ok_body', { status: outcome.status ?? 0 }),
                )
              : errorEmbed(
                  t('integrations.webhook_test_failed_title'),
                  t('integrations.webhook_test_failed_body', { error: outcome.error ?? '?' }),
                ),
          ],
        });
        break;
      }
    }
  },
};

export const commands: Command[] = [apikey, webhook];
