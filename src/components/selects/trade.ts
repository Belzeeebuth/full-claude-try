import { quantityModal } from '../../framework/ui';
import { paramString } from '../../utils/custom-id';
import type { SelectHandler } from '../../types';

/**
 * Sélection de l'objet à offrir dans un échange.
 * Le menu ouvre ensuite un modal de quantité : deux étapes, mais c'est le seul
 * moyen d'obtenir une saisie libre après un menu déroulant.
 */
const tradeItemSelect: SelectHandler = {
  namespace: 'trade',
  actions: ['pick_item'],

  async execute(interaction, parsed): Promise<void> {
    const tradeId = paramString(parsed, 0);
    const itemKey = interaction.values[0];
    if (!itemKey) return;

    await interaction.showModal(
      quantityModal({
        namespace: 'trade',
        action: 'item_qty',
        ownerId: interaction.user.id,
        params: [tradeId, itemKey],
        title: 'Quantity to offer',
        label: 'How many?',
        placeholder: 'Ex. 5',
      }),
    );
  },
};

export const handlers: SelectHandler[] = [tradeItemSelect];
