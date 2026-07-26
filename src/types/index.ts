import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  MessageContextMenuCommandInteraction,
  ModalSubmitInteraction,
  PermissionResolvable,
  RESTPostAPIApplicationCommandsJSONBody,
  StringSelectMenuInteraction,
  UserContextMenuCommandInteraction,
} from 'discord.js';
import type { Balance, GameConfig } from '../config';
import type { ParsedCustomId } from '../utils/custom-id';

/**
 * Contrats du framework interne. Ce fichier est délibérément le SEUL endroit où
 * les types de discord.js rencontrent les types du jeu : tout le reste du code
 * dépend de ces interfaces, ce qui rend une éventuelle migration de bibliothèque
 * (ou l'ajout d'un autre transport, par exemple une API HTTP) localisée.
 */

/** Enveloppe passée à chaque exécution de commande. */
export interface CommandContext {
  /** Joueur en base, créé à la volée si nécessaire (sauf `requiresAccount: false`). */
  player: PlayerContext;
  config: GameConfig;
  balance: Balance;
  /** Serveur Discord d'origine (undefined en message privé). */
  discordGuildId?: string;
  /** Locale résolue (paramètres joueur > serveur > défaut). */
  locale: string;
  /** Traduction : `t('farm.title', { name })`. */
  t: Translator;
  now: Date;
}

export interface PlayerContext {
  id: string;
  discordId: string;
  username: string;
  level: number;
  xp: number;
  coins: number;
  gems: number;
  prestige: number;
  energy: number;
  energyMax: number;
  locale: string;
  isAdmin: boolean;
  ecoBannedUntil: Date | null;
  farmId: string;
  coopId: string | null;
  coopRole: string | null;
  /** Vrai si le joueur vient d'être créé par cette interaction. */
  created: boolean;
}

export type Translator = (key: string, params?: Record<string, string | number>) => string;

export interface CommandCooldown {
  /** Secondes entre deux exécutions par le même joueur. */
  seconds: number;
  /** Clé partagée entre plusieurs commandes (ex. `market`). */
  bucket?: string;
}

export interface Command {
  /** Corps JSON prêt pour l'API Discord (produit par un SlashCommandBuilder). */
  data: RESTPostAPIApplicationCommandsJSONBody;
  /** Catégorie utilisée par `/help`. */
  category: CommandCategory;
  /** Le joueur doit-il avoir une ferme ? `false` pour `/start` et `/help`. */
  requiresAccount?: boolean;
  /** Réservé aux administrateurs du bot. */
  adminOnly?: boolean;
  /** Permissions Discord requises dans le serveur. */
  requiredPermissions?: PermissionResolvable[];
  cooldown?: CommandCooldown;
  /** Doit-on répondre en éphémère par défaut ? */
  ephemeral?: boolean;
  /** La commande fonctionne-t-elle en message privé ? */
  dmAllowed?: boolean;
  execute: (interaction: ChatInputCommandInteraction, context: CommandContext) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction, context: AutocompleteContext) => Promise<void>;
}

/** Contexte allégé pour l'autocomplétion (3 s de budget, pas de création de compte). */
export interface AutocompleteContext {
  playerId: string | null;
  discordId: string;
  config: GameConfig;
  balance: Balance;
}

export type CommandCategory =
  | 'demarrage'
  | 'agriculture'
  | 'elevage'
  | 'inventaire'
  | 'economie'
  | 'progression'
  | 'social'
  | 'monde'
  | 'admin';

export const CATEGORY_LABELS: Record<CommandCategory, { label: string; emoji: string; description: string }> = {
  demarrage: { label: 'Getting started', emoji: '🌱', description: 'Create and configure your farm' },
  agriculture: { label: 'Farming', emoji: '🌾', description: 'Plant, water, harvest' },
  elevage: { label: 'Livestock', emoji: '🐄', description: 'Animals, buildings, production' },
  inventaire: { label: 'Inventory', emoji: '🎒', description: 'Items, crafting, processing' },
  economie: { label: 'Economy', emoji: '🪙', description: 'Shop, market, bank, trading' },
  progression: { label: 'Progression', emoji: '⭐', description: 'Quests, achievements, pass, prestige' },
  social: { label: 'Social', emoji: '🤝', description: 'Co-ops, leaderboards, visits' },
  monde: { label: 'World', emoji: '🌍', description: 'Weather, seasons, events' },
  admin: { label: 'Administration', emoji: '🛠️', description: 'Staff-only commands' },
};

/** Gestionnaire de composant (bouton, menu, modal). */
export interface ComponentHandler<
  TInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
> {
  /** Espace de nom du custom_id (`farm`, `shop`, `quest`…). */
  namespace: string;
  /** Actions gérées ; `*` accepte toutes les actions du namespace. */
  actions: string[];
  /** Vérifier que le cliqueur est le propriétaire du message ? (défaut : true) */
  checkOwner?: boolean;
  requiresAccount?: boolean;
  adminOnly?: boolean;
  /** Verrou anti-double-clic appliqué autour de l'exécution. */
  lockKey?: string;
  execute: (
    interaction: TInteraction,
    parsed: ParsedCustomId,
    context: CommandContext,
  ) => Promise<void>;
}

export type ButtonHandler = ComponentHandler<ButtonInteraction>;
export type SelectHandler = ComponentHandler<StringSelectMenuInteraction>;
export type ModalHandler = ComponentHandler<ModalSubmitInteraction>;

export interface ContextMenuCommand {
  data: RESTPostAPIApplicationCommandsJSONBody;
  execute: (
    interaction: UserContextMenuCommandInteraction | MessageContextMenuCommandInteraction,
    context: CommandContext,
  ) => Promise<void>;
}

/** Résultat standard d'une action de jeu, prêt à être affiché. */
export interface ActionResult {
  title: string;
  description: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  /** Récompenses obtenues, affichées de façon homogène. */
  rewards?: {
    coins?: number;
    gems?: number;
    xp?: number;
    items?: Array<{ itemKey: string; quantity: number; quality?: string }>;
  };
  levelUp?: { from: number; to: number; rewards: string[] };
  unlockedAchievements?: string[];
}
