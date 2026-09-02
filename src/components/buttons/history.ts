import type { ButtonInteraction } from 'discord.js';
import { historyView } from '../../commands/history';
import { normalizeDays, normalizeFamily } from '../../services/history.service';
import { paramInt, paramString } from '../../utils/custom-id';
import type { ButtonHandler } from '../../types';

/**
 * Pagination de `/history`. Le custom_id transporte page, famille et période
 * (`history:page:<owner>:<page>:<famille>:<jours>`), tout ce qu'il faut pour
 * recomposer la vue sans état côté serveur : un message éphémère n'a pas de
 * cache à retrouver. Les trois paramètres sont revalidés — un bouton d'une
 * ancienne version retombe sur des valeurs sûres au lieu d'échouer.
 */
const historyButtons: ButtonHandler = {
  namespace: 'history',
  actions: ['page'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferUpdate();
    await interaction.editReply(
      await historyView(context, {
        page: paramInt(parsed, 0, { min: 1, fallback: 1 }),
        family: normalizeFamily(paramString(parsed, 1)),
        days: normalizeDays(paramString(parsed, 2)),
      }),
    );
  },
};

export const handlers: ButtonHandler[] = [historyButtons];
