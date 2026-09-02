import { getDb, lockUserRow, withTransaction, type Executor } from '../db/client';
import { translate } from '../i18n';
import { gameError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import { toSqlDate } from '../utils/time';
import * as accountRepo from '../repositories/account.repo';
import * as animalRepo from '../repositories/animal.repo';
import * as economyRepo from '../repositories/economy.repo';
import * as farmRepo from '../repositories/farm.repo';
import * as playerRepo from '../repositories/player.repo';
import * as socialRepo from '../repositories/social.repo';
import * as systemRepo from '../repositories/system.repo';
import * as tradeRepo from '../repositories/trade.repo';
import * as webhookRepo from '../repositories/webhook.repo';
import type { PlayerContext } from '../types';

const log = moduleLogger('account');

/**
 * Export et suppression de compte à l'initiative du joueur (RGPD, constat C-02).
 *
 * Deux principes :
 *  1. L'export est construit par LISTES DE CHAMPS EXPLICITES, jamais en
 *     recopiant une ligne SQL entière. Une colonne ajoutée demain au schéma
 *     (un hachage, un secret) ne peut donc pas fuiter dans le fichier sans
 *     qu'on l'ait choisie ; et `serializeExport` refuse de toute façon toute
 *     clé qui ressemble à un secret — ceinture et bretelles.
 *  2. La suppression est LOGIQUE, comme celle de `/admin reset` : la ligne
 *     `users` reste, anonymisée, pour que le journal `transactions` — la
 *     comptabilité du jeu, cf. docs/03 § 1.4 — garde ses références. Tout ce
 *     qui identifie la personne ou permet de la contacter est effacé, révoqué
 *     ou neutralisé dans une transaction unique.
 *
 * La logique pure (anonymisation, sélection des champs, bornage de taille,
 * fraîcheur de la confirmation) est exportée séparément des accès aux données
 * pour être testée sans base.
 */

export const EXPORT_FORMAT = 'harvester-export';
export const EXPORT_VERSION = 1;
/** Dernières opérations du journal comptable incluses dans l'export. */
export const EXPORT_TRANSACTION_LIMIT = 500;
/** Bornes des autres listes : l'export doit rester une pièce jointe, pas un dump. */
export const EXPORT_LIST_LIMIT = 2_000;
export const EXPORT_LISTING_LIMIT = 100;
/**
 * Taille maximale du fichier. Discord accepte 25 Mo par pièce jointe, mais un
 * export raisonnable pèse quelques centaines de Ko : au-delà de 8 Mo, quelque
 * chose cloche et on préfère tronquer les listes les moins utiles que de faire
 * échouer la commande.
 */
export const EXPORT_MAX_BYTES = 8_000_000;
/** Durée de validité du bouton de confirmation de suppression. */
export const DELETE_CONFIRMATION_TTL_SECONDS = 15 * 60;
/** Tolérance d'horloge acceptée sur une confirmation datée dans le futur. */
const CONFIRMATION_CLOCK_SKEW_SECONDS = 60;
export const DELETED_USERNAME_PREFIX = 'deleted-';

/** Toute clé de l'export dont le nom évoque un secret fait échouer la sérialisation. */
export const SENSITIVE_KEY_PATTERN = /hash|secret|token/i;

// ---------------------------------------------------------------------------
// Logique pure
// ---------------------------------------------------------------------------

/**
 * Pseudo de remplacement : `deleted-` + les 8 premiers caractères de l'UUID.
 * L'UUID v7 commence par un horodatage, donc deux comptes supprimés le même
 * jour peuvent partager ce préfixe — sans conséquence, `username` n'est pas
 * unique et ne sert plus qu'à l'affichage dans les historiques.
 */
export function anonymizedUsername(userId: string): string {
  return `${DELETED_USERNAME_PREFIX}${userId.slice(0, 8)}`;
}

export function exportFileName(discordId: string, date: Date): string {
  return `harvester-export-${discordId}-${toSqlDate(date)}.json`;
}

/**
 * Une confirmation n'est valable que quelques minutes : un bouton resté
 * affiché dans un message éphémère d'hier ne doit pas pouvoir supprimer un
 * compte sur un clic distrait. Une légère avance d'horloge est tolérée.
 */
export function isConfirmationFresh(
  issuedAtSeconds: number,
  now: Date,
  ttlSeconds = DELETE_CONFIRMATION_TTL_SECONDS,
): boolean {
  if (!Number.isFinite(issuedAtSeconds) || issuedAtSeconds <= 0) return false;
  const age = Math.floor(now.getTime() / 1000) - issuedAtSeconds;
  return age >= -CONFIRMATION_CLOCK_SKEW_SECONDS && age <= ttlSeconds;
}

function pick<T, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = source[key];
  return out;
}

// Listes de champs : ce qui n'y figure pas ne sort jamais. Exclusions
// délibérées — `avatarHash` (dérivable de Discord, et son nom déclenche la
// garde anti-secret), `suspicionScore` et `isAdmin` (internes à la modération),
// `referredBy`, `counterpartyId`, `buyerId`, `helpedBy` (identifiants d'AUTRES
// joueurs), `metadata` des transactions (peut porter l'identifiant Discord d'un
// administrateur).
const USER_FIELDS = [
  'id', 'discordId', 'username', 'displayName', 'level', 'xp', 'totalXp', 'weeklyXp',
  'prestige', 'prestigePoints', 'coins', 'gems', 'energy', 'energyMax', 'energyUpdatedAt',
  'title', 'badges', 'profileTheme', 'profileColor', 'equippedPetKey', 'totalHarvests',
  'totalPlanted', 'totalCoinsEarned', 'totalCoinsSpent', 'totalAnimalsRaised', 'totalCrafts',
  'totalWatered', 'totalHelpGiven', 'bestHarvestValue', 'commandsUsed', 'playtimeSeconds',
  'referralCode', 'ecoBannedUntil', 'ecoBanReason', 'locale', 'lastGuildId', 'lastSeenAt',
  'createdAt',
] as const;
const SETTINGS_FIELDS = [
  'dmNotifications', 'notifyCrops', 'notifyAnimals', 'notifyEnergy', 'notifyMarket',
  'notifyCoop', 'dailyReminder', 'locale', 'timezone', 'theme', 'privacy', 'compactMode',
  'confirmDestructive', 'allowVisits', 'allowTrades', 'createdAt', 'updatedAt',
] as const;
const FARM_FIELDS = [
  'id', 'name', 'gridWidth', 'gridHeight', 'fertilityBonus', 'autoWater', 'autoWaterUntil',
  'warehouseCapacity', 'craftingSlots', 'greenhouse', 'theme', 'bannerColor', 'visitsCount',
  'helpsReceived', 'createdAt',
] as const;
const PLOT_FIELDS = [
  'slot', 'x', 'y', 'state', 'fertility', 'weedLevel', 'pestType', 'pestAppearedAt',
  'pestDeadlineAt', 'lastWateredAt', 'lastHarvestAt', 'lastWeededAt', 'fallowUntil',
  'unlockedAt', 'unlockCost',
] as const;
const CROP_FIELDS = [
  'cropKey', 'plantedAt', 'readyAt', 'growthSeconds', 'withersAt', 'waterNeeded', 'waterGiven',
  'lastWateredAt', 'nextWaterAt', 'missedWaterings', 'fertilizerKey', 'fertilizerBoost',
  'qualityBoost', 'seasonPlanted', 'weatherPlanted', 'damagePenalty', 'mutation',
  'regrowRemaining', 'harvestCount', 'withered',
] as const;
const INVENTORY_FIELDS = ['itemKey', 'quality', 'mutation', 'quantity', 'locked', 'acquiredAt'] as const;
const ANIMAL_FIELDS = [
  'id', 'animalKey', 'nickname', 'hunger', 'happiness', 'health', 'statsUpdatedAt', 'bornAt',
  'lastFedAt', 'lastPettedAt', 'lastCollectedAt', 'lastTreatedAt', 'lastBredAt',
  'productionReadyAt', 'pendingProduction', 'totalProduced', 'qualityMultiplier', 'generation',
  'parentAId', 'parentBId', 'isSick', 'isAlive', 'diedAt', 'deathReason', 'purchasePrice',
] as const;
const BUILDING_FIELDS = [
  'buildingKey', 'tier', 'capacity', 'slots', 'speedMultiplier', 'condition', 'builtAt',
  'upgradedAt', 'totalInvested',
] as const;
const BANK_FIELDS = [
  'balance', 'interestRate', 'interestCap', 'lastInterestAt', 'tier', 'capacity',
  'totalDeposited', 'totalWithdrawn', 'totalInterest', 'createdAt',
] as const;
const QUEST_FIELDS = [
  'questKey', 'type', 'progress', 'required', 'status', 'cycleKey', 'slotIndex', 'rerolled',
  'assignedAt', 'expiresAt', 'completedAt', 'claimedAt',
] as const;
const ACHIEVEMENT_FIELDS = ['achievementKey', 'progress', 'unlocked', 'unlockedAt', 'claimed', 'claimedAt'] as const;
const SEASON_PASS_FIELDS = [
  'seasonPassId', 'passXp', 'tier', 'claimedTiers', 'claimedPremiumTiers', 'premium', 'premiumGrantedAt',
] as const;
const PET_FIELDS = ['petKey', 'unlockedAt'] as const;
const MINE_FIELDS = ['currentDepth', 'deepestReached', 'totalOresMined', 'createdAt'] as const;
const COOP_FIELDS = ['name', 'tag', 'level'] as const;
const COOP_MEMBER_FIELDS = [
  'role', 'joinedAt', 'contributedCoins', 'contributedItems', 'weeklyContribution', 'weeklyScore',
] as const;
const API_KEY_FIELDS = ['keyPrefix', 'label', 'createdAt', 'lastUsedAt', 'revokedAt'] as const;
const WEBHOOK_FIELDS = [
  'id', 'url', 'events', 'enabled', 'consecutiveFailures', 'lastDeliveryAt', 'lastStatus', 'createdAt',
] as const;
const LISTING_FIELDS = [
  'id', 'itemKey', 'quality', 'mutation', 'quantity', 'startPrice', 'buyoutPrice', 'currentBid',
  'listingFee', 'status', 'soldPrice', 'soldAt', 'cancelledAt', 'expiresAt', 'createdAt',
] as const;
const ORDER_FIELDS = [
  'id', 'itemKey', 'quality', 'mutation', 'maxUnitPrice', 'totalQuantity', 'remainingQuantity',
  'status', 'expiresAt', 'fulfilledAt', 'cancelledAt', 'createdAt',
] as const;
const TRANSACTION_FIELDS = [
  'id', 'type', 'currency', 'amount', 'balanceAfter', 'itemKey', 'quantity', 'unitPrice',
  'referenceType', 'referenceId', 'createdAt',
] as const;
const STREAK_FIELDS = ['currentStreak', 'longestStreak', 'lastClaimDate', 'totalClaims'] as const;

type UserRow = playerRepo.UserRow;
type SettingsRow = playerRepo.SettingsRow;
type FarmRow = playerRepo.FarmRow;
type BankRow = NonNullable<Awaited<ReturnType<typeof playerRepo.getBankAccount>>>;
type StreakRow = NonNullable<Awaited<ReturnType<typeof playerRepo.getDailyStreak>>>;
type TransactionRow = Awaited<ReturnType<typeof economyRepo.listTransactions>>[number];

/**
 * Matière première de l'export : des lignes typées par les champs RETENUS.
 * Les objets réels en portent davantage — c'est précisément ce que
 * `buildExportDocument` filtre.
 */
export interface ExportSource {
  user: Pick<UserRow, (typeof USER_FIELDS)[number]>;
  settings: Pick<SettingsRow, (typeof SETTINGS_FIELDS)[number]> | undefined;
  farm: Pick<FarmRow, (typeof FARM_FIELDS)[number]> | undefined;
  plots: Array<{
    plot: Pick<farmRepo.PlotRow, (typeof PLOT_FIELDS)[number]>;
    crop: Pick<farmRepo.PlantedCropRow, (typeof CROP_FIELDS)[number]> | null;
  }>;
  inventory: Array<Pick<accountRepo.InventoryRow, (typeof INVENTORY_FIELDS)[number]>>;
  animals: Array<Pick<animalRepo.OwnedAnimalRow, (typeof ANIMAL_FIELDS)[number]>>;
  buildings: Array<Pick<animalRepo.OwnedBuildingRow, (typeof BUILDING_FIELDS)[number]>>;
  bank: Pick<BankRow, (typeof BANK_FIELDS)[number]> | undefined;
  streak: Pick<StreakRow, (typeof STREAK_FIELDS)[number] | 'freezeTokens'> | undefined;
  quests: Array<Pick<accountRepo.UserQuestRow, (typeof QUEST_FIELDS)[number]>>;
  achievements: Array<Pick<accountRepo.UserAchievementRow, (typeof ACHIEVEMENT_FIELDS)[number]>>;
  seasonPasses: Array<Pick<accountRepo.UserSeasonPassRow, (typeof SEASON_PASS_FIELDS)[number]>>;
  pets: Array<Pick<accountRepo.OwnedPetRow, (typeof PET_FIELDS)[number]>>;
  mine: Pick<accountRepo.MineProgressRow, (typeof MINE_FIELDS)[number]> | undefined;
  coop:
    | {
        coop: Pick<socialRepo.CoopRow, (typeof COOP_FIELDS)[number]>;
        member: Pick<socialRepo.CoopMemberRow, (typeof COOP_MEMBER_FIELDS)[number]>;
      }
    | undefined;
  apiKeys: Array<Pick<accountRepo.ApiKeyRow, (typeof API_KEY_FIELDS)[number]>>;
  webhooks: Array<Pick<Awaited<ReturnType<typeof webhookRepo.listSubscriptions>>[number], (typeof WEBHOOK_FIELDS)[number]>>;
  listings: Array<Pick<tradeRepo.AuctionRow, (typeof LISTING_FIELDS)[number]>>;
  standingOrders: Array<Pick<tradeRepo.StandingOrderRow, (typeof ORDER_FIELDS)[number]>>;
  transactions: Array<Pick<TransactionRow, (typeof TRANSACTION_FIELDS)[number]>>;
}

export interface AccountExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  generatedAt: string;
  player: ExportSource['user'];
  settings: ExportSource['settings'] | null;
  farm: ExportSource['farm'] | null;
  plots: Array<ExportSource['plots'][number]['plot'] & { crop: ExportSource['plots'][number]['crop'] }>;
  inventory: ExportSource['inventory'];
  animals: ExportSource['animals'];
  buildings: ExportSource['buildings'];
  bank: ExportSource['bank'] | null;
  streak: (Pick<StreakRow, (typeof STREAK_FIELDS)[number]> & { streakFreezes: number }) | null;
  quests: ExportSource['quests'];
  achievements: ExportSource['achievements'];
  seasonPasses: ExportSource['seasonPasses'];
  pets: ExportSource['pets'];
  mine: ExportSource['mine'] | null;
  coop: (NonNullable<ExportSource['coop']>['coop'] & NonNullable<ExportSource['coop']>['member']) | null;
  apiKeys: ExportSource['apiKeys'];
  webhooks: ExportSource['webhooks'];
  listings: ExportSource['listings'];
  standingOrders: ExportSource['standingOrders'];
  transactions: ExportSource['transactions'];
  /** Sections vidées pour tenir dans `EXPORT_MAX_BYTES`. */
  truncated: string[];
}

type TruncatableSection =
  | 'transactions'
  | 'listings'
  | 'quests'
  | 'achievements'
  | 'inventory'
  | 'plots'
  | 'animals';

/** Ordre de sacrifice : d'abord l'historique volumineux, en dernier l'état de la ferme. */
export const TRUNCATION_ORDER: readonly TruncatableSection[] = [
  'transactions',
  'listings',
  'quests',
  'achievements',
  'inventory',
  'plots',
  'animals',
];

export function buildExportDocument(source: ExportSource, generatedAt: Date): AccountExport {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    generatedAt: generatedAt.toISOString(),
    player: pick(source.user, USER_FIELDS),
    settings: source.settings ? pick(source.settings, SETTINGS_FIELDS) : null,
    farm: source.farm ? pick(source.farm, FARM_FIELDS) : null,
    plots: source.plots.map(({ plot, crop }) => ({
      ...pick(plot, PLOT_FIELDS),
      crop: crop ? pick(crop, CROP_FIELDS) : null,
    })),
    inventory: source.inventory.slice(0, EXPORT_LIST_LIMIT).map((row) => pick(row, INVENTORY_FIELDS)),
    animals: source.animals.slice(0, EXPORT_LIST_LIMIT).map((row) => pick(row, ANIMAL_FIELDS)),
    buildings: source.buildings.map((row) => pick(row, BUILDING_FIELDS)),
    bank: source.bank ? pick(source.bank, BANK_FIELDS) : null,
    // « freezeTokens » est renommé : ce sont des jetons de JEU, pas des
    // secrets, mais le mot déclencherait la garde anti-secret — et le
    // renommage est plus sûr qu'une exception à la garde.
    streak: source.streak
      ? { ...pick(source.streak, STREAK_FIELDS), streakFreezes: source.streak.freezeTokens }
      : null,
    quests: source.quests.slice(0, EXPORT_LIST_LIMIT).map((row) => pick(row, QUEST_FIELDS)),
    achievements: source.achievements.slice(0, EXPORT_LIST_LIMIT).map((row) => pick(row, ACHIEVEMENT_FIELDS)),
    seasonPasses: source.seasonPasses.map((row) => pick(row, SEASON_PASS_FIELDS)),
    pets: source.pets.map((row) => pick(row, PET_FIELDS)),
    mine: source.mine ? pick(source.mine, MINE_FIELDS) : null,
    coop: source.coop
      ? { ...pick(source.coop.coop, COOP_FIELDS), ...pick(source.coop.member, COOP_MEMBER_FIELDS) }
      : null,
    apiKeys: source.apiKeys.map((row) => pick(row, API_KEY_FIELDS)),
    webhooks: source.webhooks.map((row) => pick(row, WEBHOOK_FIELDS)),
    listings: source.listings.slice(0, EXPORT_LISTING_LIMIT).map((row) => pick(row, LISTING_FIELDS)),
    standingOrders: source.standingOrders.slice(0, EXPORT_LISTING_LIMIT).map((row) => pick(row, ORDER_FIELDS)),
    transactions: source.transactions
      .slice(0, EXPORT_TRANSACTION_LIMIT)
      .map((row) => pick(row, TRANSACTION_FIELDS)),
    truncated: [],
  };
}

/** Chemins (`a.b[2].c`) de toutes les clés dont le nom évoque un secret. */
export function findSensitiveKeys(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object' || value instanceof Date) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findSensitiveKeys(entry, `${path}[${index}]`));
  }
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEY_PATTERN.test(key)) found.push(childPath);
    found.push(...findSensitiveKeys(child, childPath));
  }
  return found;
}

export interface SerializedExport {
  json: string;
  bytes: number;
  truncated: string[];
}

/**
 * Sérialise en JSON lisible (indenté : le destinataire est un humain), en
 * vidant les sections les moins précieuses tant que le fichier dépasse la
 * borne. Refuse net toute clé sensible : une telle clé ne peut venir que d'une
 * erreur de programmation, et mieux vaut une commande en échec qu'un secret
 * dans une pièce jointe.
 */
export function serializeExport(
  document: AccountExport,
  maxBytes = EXPORT_MAX_BYTES,
): SerializedExport {
  const sensitive = findSensitiveKeys(document);
  if (sensitive.length > 0) {
    throw new Error(`account export refused, sensitive keys present: ${sensitive.join(', ')}`);
  }

  let current: AccountExport = { ...document, truncated: [...document.truncated] };
  let json = JSON.stringify(current, null, 2);

  for (const section of TRUNCATION_ORDER) {
    if (Buffer.byteLength(json, 'utf8') <= maxBytes) break;
    if (current[section].length === 0) continue;
    const next: AccountExport = { ...current, truncated: [...current.truncated, section] };
    next[section] = [];
    current = next;
    json = JSON.stringify(current, null, 2);
  }

  return { json, bytes: Buffer.byteLength(json, 'utf8'), truncated: current.truncated };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface AccountExportResult extends SerializedExport {
  fileName: string;
  generatedAt: Date;
  transactions: number;
}

export async function buildAccountExport(
  player: PlayerContext,
  now: Date = new Date(),
): Promise<AccountExportResult> {
  const user = await playerRepo.findUserById(player.id);
  if (!user || user.deletedAt) {
    throw gameError('not_registered', 'Player not found.', { i18nKey: 'errors.player_not_found' });
  }

  // Lectures hors transaction, en parallèle : l'export est un instantané, pas
  // une opération économique — une récolte encaissée pendant la lecture
  // n'invalide rien.
  const [
    settings,
    farm,
    bank,
    streak,
    membership,
    inventory,
    quests,
    achievements,
    seasonPasses,
    pets,
    mine,
    apiKeys,
    webhooks,
    listings,
    orders,
    transactions,
  ] = await Promise.all([
    playerRepo.getSettings(user.id),
    playerRepo.getFarmByUserId(user.id),
    playerRepo.getBankAccount(user.id),
    playerRepo.getDailyStreak(user.id),
    socialRepo.getMembership(user.id),
    accountRepo.listInventoryRows(user.id, EXPORT_LIST_LIMIT),
    accountRepo.listQuestRows(user.id, EXPORT_LIST_LIMIT),
    accountRepo.listAchievementRows(user.id, EXPORT_LIST_LIMIT),
    accountRepo.listSeasonPassRows(user.id),
    accountRepo.listOwnedPetRows(user.id),
    accountRepo.getMineProgress(user.id),
    accountRepo.listApiKeysIncludingRevoked(user.id),
    webhookRepo.listSubscriptions(user.id),
    tradeRepo.listSellerHistory(user.id, EXPORT_LISTING_LIMIT),
    tradeRepo.listOrders(user.id),
    economyRepo.listTransactions(user.id, EXPORT_TRANSACTION_LIMIT),
  ]);

  const [plots, animals, buildings] = farm
    ? await Promise.all([
        farmRepo.listPlots(farm.id),
        animalRepo.listAnimals(farm.id, { includeDead: true }),
        animalRepo.listBuildings(farm.id),
      ])
    : [[], [], []];

  const document = buildExportDocument(
    {
      user,
      settings,
      farm,
      plots,
      inventory,
      animals: animals.map((entry) => entry.animal),
      buildings: buildings.map((entry) => entry.building),
      bank,
      streak,
      quests,
      achievements,
      seasonPasses,
      pets,
      mine,
      coop: membership,
      apiKeys,
      webhooks,
      listings: listings.map((entry) => entry.listing),
      standingOrders: orders.map((entry) => entry.order),
      transactions,
    },
    now,
  );
  const serialized = serializeExport(document);

  // Trace RGPD : une demande d'accès honorée doit pouvoir être prouvée.
  await systemRepo.audit({
    actorId: user.id,
    actorDiscordId: user.discordId,
    action: 'account_export',
    targetType: 'user',
    targetId: user.id,
    targetDiscordId: user.discordId,
    payload: {
      bytes: serialized.bytes,
      truncated: serialized.truncated,
      transactions: document.transactions.length,
    },
    severity: 'info',
  });

  log.info({ userId: user.id, bytes: serialized.bytes }, 'export de compte produit');

  return {
    ...serialized,
    fileName: exportFileName(user.discordId, now),
    generatedAt: now,
    transactions: document.transactions.length,
  };
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

export type DeletionBlocker =
  | { kind: 'listings'; count: number }
  | { kind: 'trades'; count: number }
  | { kind: 'coop_owner'; name: string };

/**
 * Ce que le joueur doit régler AVANT de partir : tout ce qui engage un autre
 * joueur. Les mises qu'il a lui-même placées ne bloquent pas — leur clôture ne
 * lèse personne d'autre que lui, et le droit à l'effacement ne se négocie pas.
 *
 * Exécuté séquentiellement : la même fonction sert sous le verrou de la
 * transaction de suppression, où un seul client PostgreSQL est disponible.
 */
export async function findDeletionBlockers(
  userId: string,
  now: Date,
  executor: Executor = getDb(),
): Promise<DeletionBlocker[]> {
  const blockers: DeletionBlocker[] = [];

  const listings = await accountRepo.countActiveListings(userId, now, executor);
  if (listings > 0) blockers.push({ kind: 'listings', count: listings });

  const trades = await accountRepo.countPendingTrades(userId, now, executor);
  if (trades > 0) blockers.push({ kind: 'trades', count: trades });

  // La direction se lit sur `guild_members.role`, pas sur `guilds.owner_id` :
  // `/coop promote` transfère le rôle sans réécrire cette colonne.
  const membership = await socialRepo.getMembership(userId, executor);
  if (membership && membership.member.role === 'owner') {
    blockers.push({ kind: 'coop_owner', name: membership.coop.name });
  }

  return blockers;
}

/** Une ligne traduite par blocage, prête pour une liste à puces. */
export function describeBlockers(blockers: DeletionBlocker[], locale: string): string[] {
  return blockers.map((blocker) => {
    switch (blocker.kind) {
      case 'listings':
        return translate(locale, 'errors.account.blocker_listings', { count: blocker.count });
      case 'trades':
        return translate(locale, 'errors.account.blocker_trades', { count: blocker.count });
      case 'coop_owner':
        return translate(locale, 'errors.account.blocker_coop_owner', { name: blocker.name });
    }
  });
}

export async function assertDeletable(
  player: Pick<PlayerContext, 'id' | 'locale'>,
  now: Date = new Date(),
  executor: Executor = getDb(),
): Promise<void> {
  const blockers = await findDeletionBlockers(player.id, now, executor);
  if (blockers.length === 0) return;
  throw gameError('invalid_state', 'Settle your listings, trades and co-op before deleting your account.', {
    i18nKey: 'errors.account.blocked',
    hintKey: 'errors.account.blocked_hint',
    params: { reasons: describeBlockers(blockers, player.locale).join('\n• ') },
    context: { blockers },
  });
}

export interface DeletionReport {
  username: string;
  apiKeysRevoked: number;
  webhooksDeleted: number;
  ordersCancelled: number;
  notificationsDropped: number;
  nicknamesCleared: number;
  leftCoop: string | null;
}

/**
 * Suppression logique complète, dans une transaction unique : soit tout est
 * fait, soit rien. Les blocages sont REVALIDÉS sous verrou — entre l'affichage
 * du bouton et le clic, une annonce a pu être publiée ou un échange ouvert.
 */
export async function deleteAccount(
  player: PlayerContext,
  now: Date = new Date(),
): Promise<DeletionReport> {
  const report = await deleteAccountTransaction(player, now);
  // Hors transaction, volontairement : voir `reassertAnonymization`.
  await accountRepo.reassertAnonymization(player.id, report.username);
  return report;
}

async function deleteAccountTransaction(
  player: PlayerContext,
  now: Date,
): Promise<DeletionReport> {
  return withTransaction(async (tx) => {
    const locked = await lockUserRow(tx, player.id);
    if (!locked) {
      throw gameError('not_registered', 'Player not found.', { i18nKey: 'errors.player_not_found' });
    }

    await assertDeletable(player, now, tx);

    const username = anonymizedUsername(player.id);
    const anonymized = await accountRepo.anonymizeUser(player.id, username, now, tx);
    if (!anonymized) {
      throw gameError('invalid_state', 'This account is already deleted.', {
        i18nKey: 'errors.account.already_deleted',
      });
    }

    await accountRepo.neutralizeSettings(player.id, now, tx);
    await accountRepo.resetFarmIdentity(player.id, now, tx);
    const nicknamesCleared = await accountRepo.clearAnimalNicknames(player.id, tx);
    const apiKeysRevoked = await accountRepo.revokeAllApiKeys(player.id, now, tx);
    const webhooksDeleted = await accountRepo.deleteAllWebhooks(player.id, tx);
    const ordersCancelled = await accountRepo.cancelAllStandingOrders(player.id, now, tx);
    const notificationsDropped = await accountRepo.deletePendingNotifications(player.id, tx);

    // Un membre ordinaire quitte sa coopérative : sans cela il y resterait
    // comme fantôme « deleted-… », compté dans l'effectif. Le chef, lui, a été
    // refusé plus haut — il doit transmettre la direction avant de partir.
    let leftCoop: string | null = null;
    const membership = await socialRepo.getMembership(player.id, tx);
    if (membership) {
      await socialRepo.leaveCoop(membership.coop.id, player.id, tx);
      leftCoop = membership.coop.name;
    }

    await systemRepo.audit(
      {
        actorId: player.id,
        actorDiscordId: player.discordId,
        action: 'account_delete',
        targetType: 'user',
        targetId: player.id,
        targetDiscordId: player.discordId,
        payload: {
          level: locked.level,
          coins: locked.coins,
          gems: locked.gems,
          apiKeysRevoked,
          webhooksDeleted,
          ordersCancelled,
          notificationsDropped,
          nicknamesCleared,
          leftCoop,
        },
        severity: 'warn',
      },
      tx,
    );

    log.warn({ userId: player.id }, 'compte supprimé à la demande du joueur');

    return {
      username,
      apiKeysRevoked,
      webhooksDeleted,
      ordersCancelled,
      notificationsDropped,
      nicknamesCleared,
      leftCoop,
    };
  });
}
