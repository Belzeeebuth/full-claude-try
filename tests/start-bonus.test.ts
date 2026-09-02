import { describe, expect, it } from 'vitest';
import { balance as getBalance } from '../src/config';
import { isGameError } from '../src/utils/errors';
import { startingGrant } from '../src/services/player.service';
import { assertTradeLevel } from '../src/services/trade.service';

/**
 * Robinet de pièces « supprimer puis recréer ».
 *
 * La suppression de compte est logique : la ligne `users` reste, `deleted_at`
 * posé, et l'unicité de `discord_id` ne porte que sur les comptes vivants. Une
 * même identité Discord pouvait donc enchaîner `/account delete` → `/start` et
 * réclamer 500 🪙 (2 000 🪙 avec un code de parrainage) à chaque tour, puis
 * expédier ces pièces à un autre compte par un achat immédiat à l'hôtel des
 * ventes — le seul transfert entre joueurs qui n'exigeait aucun niveau, alors
 * que `/trade` et `/gift` imposent `trade.minLevel`.
 *
 * Les deux moitiés du correctif sont pures et se testent sans base : le montant
 * accordé à la création, et la barrière de niveau côté acheteur.
 */

const balance = getBalance();

describe('bonus de départ : une fois par compte Discord', () => {
  it('verse le solde de départ à une première création', () => {
    const grant = startingGrant(balance.economy.startingCoins, 0, false);
    expect(grant.total).toBe(balance.economy.startingCoins);
    // Le dépôt écrit `startingCoins + bonusDelta` : sans parrain, aucun delta.
    expect(grant.bonusDelta).toBe(0);
  });

  it('ajoute le bonus de parrainage à une première création', () => {
    const referral = balance.social.referredStartBonusCoins;
    const grant = startingGrant(balance.economy.startingCoins, referral, false);
    expect(grant.total).toBe(balance.economy.startingCoins + referral);
    expect(grant.bonusDelta).toBe(referral);
  });

  it('ne verse RIEN à une recréation sur la même identité Discord', () => {
    const grant = startingGrant(balance.economy.startingCoins, 0, true);
    expect(grant.total).toBe(0);
    // Le delta ramène à zéro le solde posé par l'INSERT du dépôt.
    expect(balance.economy.startingCoins + grant.bonusDelta).toBe(0);
  });

  it('ne rouvre pas la porte par le parrainage : recréé, le compte reste à zéro', () => {
    // Le cœur du scénario : `/start code:<code de son ancien compte>`, qui
    // valait 2 000 🪙 par tour de boucle.
    const grant = startingGrant(
      balance.economy.startingCoins,
      balance.social.referredStartBonusCoins,
      true,
    );
    expect(grant.total).toBe(0);
    expect(balance.economy.startingCoins + grant.bonusDelta).toBe(0);
  });

  it('un solde nul n’écrit aucune ligne comptable (la table interdit un montant nul)', () => {
    // `transactions_amount_non_zero` : la création d'un compte recréé doit
    // sauter la ligne `starting_bonus`, et 0 = 0 vérifie déjà l'invariant
    // « solde = somme du journal ».
    expect(startingGrant(balance.economy.startingCoins, 0, true).total > 0).toBe(false);
    expect(startingGrant(balance.economy.startingCoins, 0, false).total > 0).toBe(true);
  });
});

describe("hôtel des ventes : même barrière de niveau que /trade et /gift", () => {
  it('refuse un acheteur sous le niveau minimal des échanges', () => {
    expect(() => assertTradeLevel(balance.trade.minLevel - 1)).toThrow();
    expect(() => assertTradeLevel(0)).toThrow();
  });

  it('laisse passer à partir du niveau minimal', () => {
    expect(() => assertTradeLevel(balance.trade.minLevel)).not.toThrow();
    expect(() => assertTradeLevel(balance.trade.minLevel + 40)).not.toThrow();
  });

  it('parle la langue du joueur : erreur traduite, pas un message brut', () => {
    try {
      assertTradeLevel(1);
      expect.unreachable('assertTradeLevel aurait dû lever');
    } catch (error) {
      expect(isGameError(error)).toBe(true);
      if (!isGameError(error)) return;
      expect(error.code).toBe('level_too_low');
      expect(error.i18nKey).toBe('errors.trade.min_level');
      expect(error.params).toEqual({ level: balance.trade.minLevel });
    }
  });
});
