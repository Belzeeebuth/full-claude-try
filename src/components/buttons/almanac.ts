import type { ButtonInteraction } from 'discord.js';
import { almanacView, tipLines } from '../../commands/almanac';
import { COLORS, baseEmbed } from '../../framework/ui';
import { followUpEphemeral } from '../../framework/interaction';
import * as almanacService from '../../services/almanac.service';
import { paramInt, paramString } from '../../utils/custom-id';
import { discordTimestamp, formatCoins } from '../../utils/format';
import type { ButtonHandler } from '../../types';

/**
 * Boutons de l'almanach : achat de la prévision et rafraîchissement.
 *
 * L'achat répond en deux temps : l'embed éphémère est réédité avec la
 * prévision révélée, puis un `followUp` livre la prévision une seconde fois
 * avec le reçu. Ce doublon est voulu : si l'écriture Redis échoue, la vue
 * rééditée montrerait encore le sceau alors que le joueur a payé — le reçu
 * garantit qu'il lit au moins une fois ce qu'il vient d'acheter.
 */
const almanacButtons: ButtonHandler = {
  namespace: 'almanac',
  actions: ['buy', 'refresh'],
  lockKey: 'almanac-action',

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferUpdate();

    if (parsed.action === 'buy') {
      const result = await almanacService.buyForecast(context.player, context.now, context.locale, {
        day: paramString(parsed, 0),
        // -1 ne peut jamais égaler un prix réel : un paramètre absent ou
        // altéré est refusé par le service comme un prix qui aurait changé.
        price: paramInt(parsed, 1, { min: -1, fallback: -1 }),
      });
      const { t, locale } = context;
      const weather = result.forecast.weather;

      await interaction.editReply(await almanacView(context, interaction.user.id));
      await followUpEphemeral(interaction, {
        embeds: [
          baseEmbed({
            title: result.alreadyOwned
              ? t('almanac.already_owned_title')
              : t('almanac.bought_title'),
            description: result.alreadyOwned
              ? t('almanac.already_owned_body')
              : t('almanac.bought_body', {
                  price: formatCoins(result.cost, false, locale),
                  balance: formatCoins(result.balanceAfter, false, locale),
                  emoji: weather.emoji,
                  label: weather.label,
                  temperature: weather.temperature,
                  description: weather.description,
                  relative: discordTimestamp(result.forecast.expiresAt, 'R'),
                }),
            color: COLORS.gold,
            fields: [{ name: t('almanac.tips_field'), value: tipLines(result.forecast, t) }],
          }),
        ],
      });
      return;
    }

    await interaction.editReply(await almanacView(context, interaction.user.id));
  },
};

export const handlers: ButtonHandler[] = [almanacButtons];
