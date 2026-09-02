// =============================================================================
//  Harvester — configuration ESLint (flat config, constat A-02 de l'audit)
//
//  Deux étages :
//   1. les jeux de règles standards (@eslint/js + typescript-eslint, AVEC
//      information de types : `no-floating-promises` est la règle qui attrape
//      une transaction oubliée derrière un `await` manquant) ;
//   2. des règles MAISON qui encodent les invariants du projet. Avant l'audit,
//      trois d'entre eux n'existaient que dans des commentaires — et avaient
//      été violés : l'arrondi monétaire (game/money.ts), `allowOverflow`
//      réservé aux récompenses (services/inventory.service.ts) et la réponse
//      aux interactions via le framework. Une convention dans un commentaire se
//      perd ; dans le linter, elle tient.
//
//  Chaque règle maison porte un message qui dit POURQUOI et OÙ aller. Une
//  exception se justifie par un commentaire `eslint-disable-next-line` qui
//  explique le cas — et `reportUnusedDisableDirectives` refuse les directives
//  fantômes, pour qu'une exception morte ne survive pas à son code.
// =============================================================================
'use strict';

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

/** Cibles du lint : le code et ses tests, rien d'autre (config, scripts de build…). */
const SOURCES = ['src/**/*.ts', 'tests/**/*.ts'];

// -----------------------------------------------------------------------------
//  Règle locale : `allowOverflow: true` doit être justifié par un commentaire.
//
//  `inventoryService.addItems(…, { allowOverflow: true })` contourne la capacité
//  de l'entrepôt. C'est une EXCEPTION réservée à ce qu'on ne peut pas refuser
//  sans le détruire — récompense, remboursement, livraison d'un échange, retour
//  d'une marchandise — jamais le mode normal (21 des 22 appels du projet le
//  passaient avant l'audit, et la capacité ne limitait plus rien).
//
//  Un sélecteur `no-restricted-syntax` ne sait pas lire les commentaires : cette
//  petite règle regarde ceux qui précèdent l'instruction englobante, ou qui sont
//  placés dans l'appel avant la propriété, et exige l'un des mots-clés.
// -----------------------------------------------------------------------------
const OVERFLOW_JUSTIFICATION = /r[ée]compense|remboursement|livraison|retour/i;

/** Remonte jusqu'à l'instruction (ou la déclaration) qui contient le nœud. */
function enclosingStatement(node) {
  let current = node;
  while (current.parent && !/(Statement|Declaration)$/.test(current.parent.type)) {
    current = current.parent;
  }
  return current.parent ?? current;
}

const justifiedOverflowRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "`allowOverflow: true` doit être justifié par un commentaire (récompense, remboursement, livraison, retour)",
    },
    schema: [],
    messages: {
      unjustified:
        "`allowOverflow: true` contourne la capacité de l'entrepôt : réservé à ce qu'on ne peut pas refuser " +
        'sans le DÉTRUIRE (récompense, remboursement, livraison, retour). Justifie-le par un commentaire contenant ' +
        "l'un de ces mots juste avant l'appel, ou laisse la capacité être vérifiée — cf. " +
        'src/services/inventory.service.ts (addItems).',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      "Property[key.name='allowOverflow'] > Literal[value=true]"(literal) {
        const property = literal.parent;
        const statement = enclosingStatement(property);
        const comments = [
          ...sourceCode.getCommentsBefore(statement),
          ...sourceCode.getCommentsInside(statement).filter((c) => c.range[1] <= property.range[0]),
        ];
        if (!comments.some((comment) => OVERFLOW_JUSTIFICATION.test(comment.value))) {
          context.report({ node: property, messageId: 'unjustified' });
        }
      },
    };
  },
};

// -----------------------------------------------------------------------------
//  Sélecteurs des règles maison
// -----------------------------------------------------------------------------

/**
 * `Math.round` / `Math.ceil` sur une expression qui mentionne un identifiant
 * monétaire. Le sélecteur descend dans l'argument de l'appel et s'arrête sur le
 * premier identifiant dont le nom évoque de l'argent : c'est lui qui est
 * signalé, ce qui pointe l'expression fautive plutôt que le `Math`.
 */
const MONEY_ROUNDING =
  "CallExpression[callee.type='MemberExpression'][callee.object.name='Math'][callee.property.name=/^(round|ceil)$/] " +
  'Identifier[name=/coins|price|reward|amount|cost|fee|value|total|gems|bid/i]';

const MONEY_ROUNDING_MESSAGE =
  "Pas de Math.round/Math.ceil sur de la monnaie : cumulé sur des millions d'opérations, un arrondi crée de la " +
  "monnaie ex nihilo. Utilise scaleMoney (gain, arrondi à la baisse) ou feeOf (taxe, arrondi au supérieur) de " +
  "src/game/money.ts. Si l'expression n'est pas monétaire (XP, pagination…), renomme l'identifiant plutôt que " +
  "d'ajouter une exception.";

/** `interaction.reply(…)` / `interaction.followUp(…)` appelés directement. */
const DIRECT_INTERACTION_REPLY =
  "CallExpression[callee.type='MemberExpression'][callee.object.name='interaction'][callee.property.name=/^(reply|followUp)$/]";

const DIRECT_INTERACTION_REPLY_MESSAGE =
  'Passe par le framework (src/framework/interaction.ts) : safeReply / replyEphemeral pour répondre, ' +
  "followUpEphemeral pour un message complémentaire après un deferUpdate(). Ils gèrent l'état deferred / " +
  'replied / ephemeral et une interaction expirée sans faire tomber le gestionnaire.';

/** `buildCustomId(ns, action, '…')` avec un ownerId littéral. */
const LITERAL_OWNER_ID =
  "CallExpression[callee.name='buildCustomId']:matches(" +
  "[arguments.2.type='Literal'], " +
  "[arguments.2.type='TemplateLiteral'][arguments.2.expressions.length=0])";

const LITERAL_OWNER_ID_MESSAGE =
  "L'ownerId d'un custom_id doit être l'identifiant du cliqueur (interaction.user.id) — c'est ce qui empêche " +
  "de cliquer sur le bouton d'un autre — ou la constante PUBLIC_OWNER pour un composant volontairement public. " +
  'Jamais un littéral.';

/** `process.env` lu ou écrit directement. */
const PROCESS_ENV = "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env']";

const PROCESS_ENV_MESSAGE =
  "Passe par `env` (src/config/env.ts) : l'environnement y est validé une seule fois, avec ses valeurs par " +
  'défaut et ses bornes. Une variable manquante au schéma se déclare là-bas, pas ici.';

/**
 * Les règles maison vivent toutes dans `no-restricted-syntax`, dont la
 * configuration se REMPLACE (elle ne fusionne pas) d'un bloc à l'autre : chaque
 * groupe de fichiers nomme donc explicitement le jeu qui s'applique à lui.
 */
const HOUSE_RULES = {
  literalOwnerId: { selector: LITERAL_OWNER_ID, message: LITERAL_OWNER_ID_MESSAGE },
  processEnv: { selector: PROCESS_ENV, message: PROCESS_ENV_MESSAGE },
  directReply: { selector: DIRECT_INTERACTION_REPLY, message: DIRECT_INTERACTION_REPLY_MESSAGE },
  moneyRounding: { selector: MONEY_ROUNDING, message: MONEY_ROUNDING_MESSAGE },
};

function restrict(...names) {
  return ['error', ...names.map((name) => HOUSE_RULES[name])];
}

module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'out/**', 'coverage/**', 'drizzle/**', 'node_modules/**'],
  },

  // ---------------------------------------------------------------------------
  //  Socle : @eslint/js + typescript-eslint avec information de types
  // ---------------------------------------------------------------------------
  {
    files: SOURCES,
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    linterOptions: {
      // Une directive `eslint-disable` qui ne désactive plus rien est une
      // exception morte : elle doit partir avec le code qu'elle couvrait.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Les arguments préfixés `_` sont des paramètres imposés par une signature
      // (gestionnaires, callbacks) que l'on n'utilise pas : c'est voulu.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // `ignoreReadBeforeAssign` : un `let` lu par une fermeture définie avant son
      // affectation (le `shutdown` de index.ts) ne peut pas devenir `const` sans
      // créer une zone morte temporelle.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      eqeqeq: ['error', 'always'],
      // Une promesse oubliée, c'est une transaction qui se termine après la
      // réponse au joueur — ou une erreur que personne ne voit.
      '@typescript-eslint/no-floating-promises': 'error',
      // `console` n'est pas un logger : ni structuré, ni filtré par niveau, ni
      // masqué (les secrets). Seuls les scripts en ligne de commande y ont droit.
      'no-console': 'error',
    },
  },

  // ---------------------------------------------------------------------------
  //  Règles maison — jeu par défaut, puis ajustements par zone
  // ---------------------------------------------------------------------------
  {
    files: SOURCES,
    plugins: {
      harvester: { rules: { 'justified-overflow': justifiedOverflowRule } },
    },
    rules: {
      'no-restricted-syntax': restrict('literalOwnerId', 'processEnv', 'directReply'),
    },
  },

  // Monnaie : les services et la logique de jeu manipulent des montants ; c'est
  // là que l'arrondi doit passer par les helpers.
  {
    files: ['src/services/**/*.ts', 'src/game/**/*.ts'],
    rules: {
      'no-restricted-syntax': restrict('literalOwnerId', 'processEnv', 'directReply', 'moneyRounding'),
    },
  },

  // `allowOverflow` : uniquement dans le code de production. Les tests posent
  // des dotations d'inventaire en fixture, ce qui n'engage aucun invariant.
  {
    files: ['src/**/*.ts'],
    rules: { 'harvester/justified-overflow': 'error' },
  },

  // ---------------------------------------------------------------------------
  //  Exceptions, explicitées ici plutôt que par des commentaires épars
  // ---------------------------------------------------------------------------

  // money.ts EST le helper d'arrondi : c'est le seul endroit où Math.ceil sur
  // un montant est légitime.
  {
    files: ['src/game/money.ts'],
    rules: { 'no-restricted-syntax': restrict('literalOwnerId', 'processEnv', 'directReply') },
  },

  // Le framework est l'implémentation de safeReply/replyEphemeral : il appelle
  // forcément `interaction.reply` et `interaction.followUp`.
  {
    files: ['src/framework/**/*.ts'],
    rules: { 'no-restricted-syntax': restrict('literalOwnerId', 'processEnv') },
  },

  // Accès direct à `process.env`, là où passer par `env` est impossible :
  //  - config/env.ts : c'est lui qui valide l'environnement ;
  //  - utils/logger.ts : doit fonctionner AVANT la validation (pour pouvoir en
  //    signaler l'échec) et rester importable sans traîner l'environnement ;
  //  - client.ts : neutralise SHARD_COUNT / SHARDS, variables du protocole
  //    interne de discord.js, qui ne sont pas de la configuration Harvester ;
  //  - scripts/ : outils en ligne de commande, qui posent l'environnement AVANT
  //    de charger env.ts (offline-env.ts) ou lisent des variables d'aperçu qui
  //    n'ont rien à faire dans le schéma du bot ; `console` y est leur sortie.
  {
    files: ['src/config/env.ts', 'src/utils/logger.ts', 'src/client.ts', 'src/scripts/**/*.ts'],
    rules: { 'no-restricted-syntax': restrict('literalOwnerId', 'directReply') },
  },
  {
    files: ['src/scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // Les tests posent l'environnement eux-mêmes et construisent des custom_id
  // avec des propriétaires fictifs : seule la réponse aux interactions reste
  // encadrée (un test qui simule un gestionnaire doit passer par le framework).
  {
    files: ['tests/**/*.ts'],
    rules: { 'no-restricted-syntax': restrict('directReply') },
  },
);
