import type { ButtonInteraction } from 'discord.js';
import { collectionView } from '../../commands/collection';
import { normalizeKind } from '../../game/collection';
import { paramInt, paramString } from '../../utils/custom-id';
import type { ButtonHandler } from '../../types';

/**
 * Boutons de `/collection` : filtre de famille, pagination, rafraîchissement.
 *
 * Trois formes de custom_id, toutes sans état serveur :
 *   collection:kind:<owner>:<famille>            → page 1 de la famille
 *   collection:page:<owner>:<page>:<famille>     → rangée de pagination standard
 *   collection:refresh:<owner>:<famille>:<page>  → même page, relue
 * Famille et page sont revalidées : un paramètre absent ou altéré retombe sur
 * les cultures et la page 1 plutôt que d'échouer.
 */
const collectionButtons: ButtonHandler = {
  namespace: 'collection',
  actions: ['kind', 'page', 'refresh', 'noop'],

  async execute(interaction: ButtonInteraction, parsed, context): Promise<void> {
    await interaction.deferUpdate();
    const input =
      parsed.action === 'kind'
        ? { kind: normalizeKind(paramString(parsed, 0)), page: 1 }
        : parsed.action === 'page'
          ? {
              page: paramInt(parsed, 0, { min: 1, fallback: 1 }),
              kind: normalizeKind(paramString(parsed, 1)),
            }
          : {
              kind: normalizeKind(paramString(parsed, 0)),
              page: paramInt(parsed, 1, { min: 1, fallback: 1 }),
            };
    await interaction.editReply(await collectionView(context, input));
  },
};

export const handlers: ButtonHandler[] = [collectionButtons];
