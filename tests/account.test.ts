import { describe, expect, it } from 'vitest';
import {
  DELETED_USERNAME_PREFIX,
  DELETE_CONFIRMATION_TTL_SECONDS,
  EXPORT_FORMAT,
  EXPORT_TRANSACTION_LIMIT,
  SENSITIVE_KEY_PATTERN,
  TRUNCATION_ORDER,
  anonymizedUsername,
  buildExportDocument,
  describeBlockers,
  exportFileName,
  findSensitiveKeys,
  isConfirmationFresh,
  serializeExport,
  type ExportSource,
} from '../src/services/account.service';

/**
 * Export et suppression de compte (RGPD) : logique pure uniquement — aucune
 * base, aucun Redis. Ce qui est testé ici est ce qui protège réellement le
 * joueur : qu'aucun secret ne sorte dans l'export, que l'anonymisation soit
 * stable, que le fichier reste borné et qu'une confirmation périmée ne puisse
 * pas supprimer un compte.
 */

const NOW = new Date('2026-09-02T10:30:00Z');
const USER_ID = '01920000-abcd-7000-8000-000000000001';

/**
 * Lignes « telles que la base les rend » : elles portent volontairement des
 * colonnes sensibles (`avatarHash`, `keyHash`, `secret`, `suspicionScore`,
 * `freezeTokens`) pour vérifier que la sélection de champs les élimine.
 */
function sampleSource(overrides: Partial<ExportSource> = {}): ExportSource {
  const user = {
    id: USER_ID,
    discordId: '123456789012345678',
    username: 'farmer',
    displayName: 'Farmer Joe',
    avatarHash: 'a1b2c3d4e5f6',
    suspicionScore: 42,
    isAdmin: false,
    referredBy: '01920000-abcd-7000-8000-000000000009',
    level: 12,
    xp: 340,
    totalXp: 12_000,
    weeklyXp: 900,
    prestige: 0,
    prestigePoints: 0,
    coins: 15_000,
    gems: 12,
    energy: 80,
    energyMax: 100,
    energyUpdatedAt: NOW,
    title: null,
    badges: ['early_bird'],
    profileTheme: 'classic',
    profileColor: '#4ca64c',
    equippedPetKey: 'dog',
    totalHarvests: 200,
    totalPlanted: 210,
    totalCoinsEarned: 50_000,
    totalCoinsSpent: 35_000,
    totalAnimalsRaised: 3,
    totalCrafts: 8,
    totalWatered: 400,
    totalHelpGiven: 2,
    bestHarvestValue: 900,
    commandsUsed: 1_500,
    playtimeSeconds: 36_000,
    referralCode: 'ABCD2345',
    ecoBannedUntil: null,
    ecoBanReason: null,
    locale: 'fr',
    lastGuildId: '987654321098765432',
    lastSeenAt: NOW,
    createdAt: NOW,
  };

  // Construites hors littéral : TypeScript refuserait sinon les colonnes en
  // trop, alors que c'est précisément leur présence qu'on veut voir filtrée.
  const crop = {
    cropKey: 'wheat',
    plantedAt: NOW,
    readyAt: NOW,
    growthSeconds: 600,
    withersAt: null,
    waterNeeded: 1,
    waterGiven: 1,
    lastWateredAt: NOW,
    nextWaterAt: null,
    missedWaterings: 0,
    fertilizerKey: null,
    fertilizerBoost: '0.000',
    qualityBoost: '0.000',
    seasonPlanted: 'spring' as const,
    weatherPlanted: 'sunny' as const,
    damagePenalty: '0.000',
    mutation: 'none' as const,
    regrowRemaining: 0,
    harvestCount: 0,
    withered: false,
    helpedBy: ['01920000-abcd-7000-8000-000000000042'],
  };

  const apiKey = {
    keyPrefix: 'hvst_abcdef0',
    keyHash: 'deadbeef'.repeat(8),
    label: 'default',
    createdAt: NOW,
    lastUsedAt: null,
    revokedAt: null,
  };

  const webhook = {
    id: '01920000-abcd-7000-8000-0000000000aa',
    url: 'https://example.com/hook',
    secret: 'supersecret',
    events: ['crop_ready'],
    enabled: true,
    consecutiveFailures: 0,
    lastDeliveryAt: null,
    lastStatus: null,
    createdAt: NOW,
  };

  const transactions = Array.from({ length: EXPORT_TRANSACTION_LIMIT + 100 }, (_, index) => ({
    id: index + 1,
    type: 'harvest_sale' as const,
    currency: 'coins' as const,
    amount: 10,
    balanceAfter: 1_000 + index,
    itemKey: 'wheat',
    quantity: 1,
    unitPrice: 10,
    counterpartyId: '01920000-abcd-7000-8000-000000000042',
    referenceType: null,
    referenceId: null,
    discordGuildId: '987654321098765432',
    metadata: { actor: '111111111111111111' },
    createdAt: NOW,
  }));

  return {
    user,
    settings: {
      dmNotifications: true,
      notifyCrops: true,
      notifyAnimals: true,
      notifyEnergy: false,
      notifyMarket: false,
      notifyCoop: true,
      dailyReminder: false,
      locale: 'fr',
      timezone: 'Europe/Paris',
      theme: 'classic',
      privacy: 'public',
      compactMode: false,
      confirmDestructive: true,
      allowVisits: true,
      allowTrades: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
    farm: {
      id: '01920000-abcd-7000-8000-0000000000f0',
      name: 'Green Acres',
      gridWidth: 3,
      gridHeight: 3,
      fertilityBonus: 0,
      autoWater: false,
      autoWaterUntil: null,
      warehouseCapacity: 300,
      craftingSlots: 1,
      greenhouse: false,
      theme: 'classic',
      bannerColor: '#7ec850',
      visitsCount: 4,
      helpsReceived: 1,
      createdAt: NOW,
    },
    plots: [
      {
        plot: {
          slot: 1,
          x: 0,
          y: 0,
          state: 'planted',
          fertility: 70,
          weedLevel: 0,
          pestType: null,
          pestAppearedAt: null,
          pestDeadlineAt: null,
          lastWateredAt: NOW,
          lastHarvestAt: null,
          lastWeededAt: null,
          fallowUntil: null,
          unlockedAt: NOW,
          unlockCost: 0,
        },
        crop,
      },
    ],
    inventory: [
      { itemKey: 'wheat', quality: 'normal', mutation: 'none', quantity: 30, locked: false, acquiredAt: NOW },
    ],
    animals: [],
    buildings: [
      {
        buildingKey: 'warehouse',
        tier: 1,
        capacity: 300,
        slots: 0,
        speedMultiplier: '1.000',
        condition: 100,
        builtAt: NOW,
        upgradedAt: null,
        totalInvested: 0,
      },
    ],
    bank: {
      balance: 2_000,
      interestRate: '0.0050',
      interestCap: 5_000,
      lastInterestAt: NOW,
      tier: 1,
      capacity: 50_000,
      totalDeposited: 2_000,
      totalWithdrawn: 0,
      totalInterest: 0,
      createdAt: NOW,
    },
    streak: { currentStreak: 3, longestStreak: 9, lastClaimDate: '2026-09-02', totalClaims: 20, freezeTokens: 1 },
    quests: [],
    achievements: [],
    seasonPasses: [],
    pets: [{ petKey: 'dog', unlockedAt: NOW }],
    mine: undefined,
    coop: {
      coop: { name: 'Wheat Barons', tag: 'WHT', level: 2 },
      member: {
        role: 'member',
        joinedAt: NOW,
        contributedCoins: 500,
        contributedItems: 0,
        weeklyContribution: 100,
        weeklyScore: 10,
      },
    },
    apiKeys: [apiKey],
    webhooks: [webhook],
    listings: [],
    standingOrders: [],
    transactions,
    ...overrides,
  };
}

/** Toutes les clés présentes dans un objet, à n'importe quelle profondeur. */
function allKeys(value: unknown): Set<string> {
  const keys = new Set<string>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || node instanceof Date) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      keys.add(key);
      walk(child);
    }
  };
  walk(value);
  return keys;
}

describe('anonymisation du pseudo', () => {
  it('remplace le pseudo par un identifiant dérivé, stable et court', () => {
    const username = anonymizedUsername(USER_ID);
    expect(username).toBe(`${DELETED_USERNAME_PREFIX}01920000`);
    expect(username).toBe(anonymizedUsername(USER_ID));
    // Colonne `users.username` : VARCHAR(32).
    expect(username.length).toBeLessThanOrEqual(32);
  });

  it('ne laisse rien transparaître du pseudo d\'origine', () => {
    expect(anonymizedUsername(USER_ID)).not.toContain('farmer');
    expect(anonymizedUsername('ffffffff-0000-7000-8000-000000000000')).not.toBe(anonymizedUsername(USER_ID));
  });
});

describe('export : sélection des champs', () => {
  const document = buildExportDocument(sampleSource(), NOW);

  it('ne contient aucune clé évoquant un hachage, un secret ou un jeton', () => {
    expect(findSensitiveKeys(document)).toEqual([]);
    for (const key of allKeys(document)) {
      expect(key, `clé sensible dans l'export : ${key}`).not.toMatch(SENSITIVE_KEY_PATTERN);
    }
  });

  it('détecte effectivement une clé sensible (auto-contrôle de la garde)', () => {
    expect(findSensitiveKeys({ apiKeys: [{ keyHash: 'x' }], webhook: { secret: 'y' } })).toEqual([
      'apiKeys[0].keyHash',
      'webhook.secret',
    ]);
    expect(SENSITIVE_KEY_PATTERN.test('freezeTokens')).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test('keyPrefix')).toBe(false);
  });

  it('garde les préfixes de clés API et les URL de webhook, sans leurs secrets', () => {
    expect(document.apiKeys).toEqual([
      { keyPrefix: 'hvst_abcdef0', label: 'default', createdAt: NOW, lastUsedAt: null, revokedAt: null },
    ]);
    expect(document.webhooks[0]).toMatchObject({ url: 'https://example.com/hook', events: ['crop_ready'] });
    expect(document.webhooks[0]).not.toHaveProperty('secret');
  });

  it('écarte les champs internes et les identifiants d\'autres joueurs', () => {
    const player = document.player as Record<string, unknown>;
    expect(player.suspicionScore).toBeUndefined();
    expect(player.isAdmin).toBeUndefined();
    expect(player.referredBy).toBeUndefined();
    expect(player.avatarHash).toBeUndefined();
    expect(player.username).toBe('farmer');

    const crop = document.plots[0]?.crop as Record<string, unknown>;
    expect(crop.helpedBy).toBeUndefined();
    expect(crop.cropKey).toBe('wheat');

    const transaction = document.transactions[0] as Record<string, unknown>;
    expect(transaction.counterpartyId).toBeUndefined();
    expect(transaction.metadata).toBeUndefined();
    expect(transaction.discordGuildId).toBeUndefined();
    expect(transaction.amount).toBe(10);
  });

  it('borne le journal aux 500 dernières opérations', () => {
    expect(document.transactions).toHaveLength(EXPORT_TRANSACTION_LIMIT);
  });

  it('renomme les jetons de gel de série, qui sont des objets de jeu', () => {
    expect(document.streak).toEqual({
      currentStreak: 3,
      longestStreak: 9,
      lastClaimDate: '2026-09-02',
      totalClaims: 20,
      streakFreezes: 1,
    });
  });

  it('tolère un compte sans ferme, sans banque, sans coopérative', () => {
    const bare = buildExportDocument(
      sampleSource({ farm: undefined, bank: undefined, coop: undefined, streak: undefined, plots: [] }),
      NOW,
    );
    expect(bare.farm).toBeNull();
    expect(bare.bank).toBeNull();
    expect(bare.coop).toBeNull();
    expect(bare.streak).toBeNull();
    expect(bare.plots).toEqual([]);
  });
});

describe('export : sérialisation et taille', () => {
  const document = buildExportDocument(sampleSource(), NOW);

  it('produit un JSON valide et daté, sans troncature en régime normal', () => {
    const { json, bytes, truncated } = serializeExport(document);
    const parsed = JSON.parse(json) as { format: string; version: number; generatedAt: string };
    expect(parsed.format).toBe(EXPORT_FORMAT);
    expect(parsed.version).toBe(1);
    expect(parsed.generatedAt).toBe(NOW.toISOString());
    expect(bytes).toBe(Buffer.byteLength(json, 'utf8'));
    expect(truncated).toEqual([]);
  });

  it('vide les sections dans l\'ordre prévu tant que la borne est dépassée', () => {
    const full = serializeExport(document).bytes;
    // Borne = taille exacte du document une fois les transactions retirées,
    // mention de troncature comprise : assez petite pour forcer leur abandon,
    // juste assez grande pour garder tout le reste.
    const withoutTransactions = serializeExport({
      ...document,
      transactions: [],
      truncated: ['transactions'],
    }).bytes;
    const { truncated, bytes } = serializeExport(document, withoutTransactions);
    expect(bytes).toBeLessThan(full);
    expect(bytes).toBeLessThanOrEqual(withoutTransactions);
    expect(truncated).toEqual(['transactions']);
  });

  it('sacrifie tout ce qui peut l\'être avant de renoncer, et le dit', () => {
    const { truncated, json } = serializeExport(document, 1);
    const parsed = JSON.parse(json) as Record<string, unknown[]>;
    // Les sections vides au départ (animaux, quêtes…) ne sont pas listées : rien n'a été retiré.
    expect(truncated).toEqual(
      TRUNCATION_ORDER.filter((section) => document[section].length > 0),
    );
    for (const section of truncated) expect(parsed[section]).toEqual([]);
    expect(parsed.player).toBeDefined();
  });

  it('refuse de sérialiser un document qui contiendrait un secret', () => {
    const poisoned = { ...document, webhooks: [{ ...document.webhooks[0]!, secret: 'leak' }] };
    expect(() => serializeExport(poisoned as typeof document)).toThrow(/sensitive/);
  });

  it('nomme le fichier par identifiant Discord et par jour', () => {
    expect(exportFileName('123456789012345678', NOW)).toBe(
      'harvester-export-123456789012345678-2026-09-02.json',
    );
  });
});

describe('confirmation de suppression', () => {
  const issued = Math.floor(NOW.getTime() / 1000);

  it('accepte une confirmation récente et refuse une confirmation périmée', () => {
    expect(isConfirmationFresh(issued, NOW)).toBe(true);
    expect(isConfirmationFresh(issued - DELETE_CONFIRMATION_TTL_SECONDS, NOW)).toBe(true);
    expect(isConfirmationFresh(issued - DELETE_CONFIRMATION_TTL_SECONDS - 1, NOW)).toBe(false);
  });

  it('tolère une légère avance d\'horloge mais pas une date fantaisiste', () => {
    expect(isConfirmationFresh(issued + 30, NOW)).toBe(true);
    expect(isConfirmationFresh(issued + 3_600, NOW)).toBe(false);
    expect(isConfirmationFresh(0, NOW)).toBe(false);
    expect(isConfirmationFresh(Number.NaN, NOW)).toBe(false);
  });
});

describe('blocages de suppression', () => {
  it('décrit chaque blocage dans la langue du joueur', () => {
    const lines = describeBlockers(
      [
        { kind: 'listings', count: 2 },
        { kind: 'trades', count: 1 },
        { kind: 'coop_owner', name: 'Wheat Barons' },
      ],
      'en',
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('2');
    expect(lines[2]).toContain('Wheat Barons');
    // Chaque ligne est bien une traduction résolue, pas une clé renvoyée telle quelle.
    for (const line of lines) expect(line).not.toMatch(/^errors\./);
  });
});
