import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Collection du fermier : QUI a le droit d'enregistrer une découverte.
 *
 * `addItems` est l'unique porte d'entrée de l'inventaire — la production
 * (récolte, pêche, mine, élevage, artisanat) mais aussi tout ce qui ne fait
 * que changer de mains : achat à l'hôtel des ventes, échange, retour d'annonce
 * annulée, remboursement d'artisanat, don d'administration. Enregistrer une
 * découverte pour TOUTE entrée ouvrait `herbarium_complete` (40 000 🪙 + 10 💎)
 * et les succès `collection_*` à un compte qui n'a jamais planté : il suffisait
 * qu'un complice lui passe les 41 récoltes par `/trade`. La même porte gonflait
 * le « ×n » de `/collection` à chaque cycle « lister puis annuler ».
 *
 * Le dépôt d'inventaire et le service de collection sont remplacés par des
 * doubles : ce qui est testé ici est la DÉCISION d'enregistrer, pas le SQL.
 */

vi.mock('../src/repositories/inventory.repo', () => ({
  addItems: vi.fn(),
  totalQuantity: vi.fn(),
  removeItem: vi.fn(),
  removeItemAnyQuality: vi.fn(),
  countItem: vi.fn(),
}));

vi.mock('../src/repositories/player.repo', () => ({
  getFarmByUserId: vi.fn(),
}));

vi.mock('../src/services/collection.service', () => ({
  recordItemDiscoveries: vi.fn(),
}));

import * as inventoryRepo from '../src/repositories/inventory.repo';
import * as playerRepo from '../src/repositories/player.repo';
import * as collectionService from '../src/services/collection.service';
import { addItems } from '../src/services/inventory.service';
import type { Executor } from '../src/db/client';

/** Le double de transaction ne sert qu'à être transmis aux dépôts mockés. */
const tx = {} as Executor;

/** Une récolte : la catégorie `harvest` est bien une famille qui se découvre. */
const WHEAT = [{ itemKey: 'wheat', quantity: 100 }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(inventoryRepo.addItems).mockResolvedValue(undefined);
  vi.mocked(inventoryRepo.totalQuantity).mockResolvedValue(0);
  vi.mocked(playerRepo.getFarmByUserId).mockResolvedValue({ warehouseCapacity: 10_000 } as never);
  vi.mocked(collectionService.recordItemDiscoveries).mockResolvedValue({} as never);
});

describe('découvertes : seule la production compte', () => {
  it("un objet reçu par échange ou acheté à l'hôtel des ventes n'est pas une découverte", async () => {
    // Le chemin exact de `confirmTrade`, `executeBuyout` et `cancelListing` :
    // `allowOverflow` (on ne peut pas refuser sans détruire), et AUCUN
    // `discover`.
    await addItems('u1', WHEAT, tx, { allowOverflow: true });

    expect(inventoryRepo.addItems).toHaveBeenCalledTimes(1);
    expect(collectionService.recordItemDiscoveries).not.toHaveBeenCalled();
  });

  it('un objet récolté est une découverte', async () => {
    await addItems('u1', WHEAT, tx, { discover: true });

    expect(collectionService.recordItemDiscoveries).toHaveBeenCalledTimes(1);
    expect(collectionService.recordItemDiscoveries).toHaveBeenCalledWith(
      { userId: 'u1' },
      WHEAT,
      tx,
    );
  });

  it("l'option est refusée par défaut : un nouvel appelant n'ouvre pas la collection par mégarde", async () => {
    await addItems('u1', WHEAT, tx);

    expect(collectionService.recordItemDiscoveries).not.toHaveBeenCalled();
  });

  it('lister puis annuler la même pile ne compte rien, autant de fois qu\'on veut', async () => {
    // `createListing` retire, `cancelListing` rend : cinq cycles ajoutaient
    // 500 au compteur affiché par `/collection` sans une seule récolte.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await addItems('u1', WHEAT, tx, { allowOverflow: true });
    }

    expect(inventoryRepo.addItems).toHaveBeenCalledTimes(5);
    expect(collectionService.recordItemDiscoveries).not.toHaveBeenCalled();
  });

  it('une entrée vide ne touche à rien, même en production', async () => {
    await addItems('u1', [{ itemKey: 'wheat', quantity: 0 }], tx, { discover: true });

    expect(inventoryRepo.addItems).not.toHaveBeenCalled();
    expect(collectionService.recordItemDiscoveries).not.toHaveBeenCalled();
  });
});
