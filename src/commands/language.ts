import {
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type RepliableInteraction,
} from 'discord.js';
import { COLORS, baseEmbed, button, row } from '../framework/ui';
import { SUPPORTED_LOCALES, translate, type SupportedLocale } from '../i18n';
import * as playerRepo from '../repositories/player.repo';
import type { Command, CommandContext } from '../types';

/**
 * `/lang` — changer la langue de l'interface.
 *
 * Le réglage existe déjà dans `/settings langue`, mais il y est noyé au milieu
 * de quatre autres options. Une commande dédiée est ce qu'un joueur cherche
 * réellement, et c'est aussi le seul point d'entrée qu'un anglophone perdu dans
 * une interface française a une chance de deviner.
 *
 * Deux détails qui comptent :
 *  - la confirmation est rédigée dans la NOUVELLE langue, pas dans l'ancienne :
 *    c'est ce qui prouve au joueur que le changement a pris ;
 *  - `context.locale` porte encore l'ancienne valeur pendant cette exécution
 *    (il a été résolu avant la commande), on utilise donc explicitement la
 *    locale cible pour tout ce qui est affiché ensuite.
 */

const LOCALE_META: Record<SupportedLocale, { label: string; flag: string; native: string }> = {
  fr: { label: 'Français', flag: '🇫🇷', native: 'Français' },
  en: { label: 'English', flag: '🇬🇧', native: 'English' },
};

function isSupported(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** Embed de confirmation, rédigé dans la langue cible. */
function confirmationEmbed(locale: SupportedLocale) {
  const meta = LOCALE_META[locale];
  return baseEmbed({
    title: `${meta.flag} ${translate(locale, 'settings.language_set_title')}`,
    description: translate(locale, 'settings.language_set_body', { language: meta.native }),
    color: COLORS.success,
    fields: [
      {
        name: translate(locale, 'settings.language_scope_title'),
        value: translate(locale, 'settings.language_scope_body'),
        inline: false,
      },
    ],
  });
}

/** Boutons de choix, un par langue, la langue courante étant désactivée. */
function localeRow(ownerId: string, current: SupportedLocale) {
  return row(
    ...SUPPORTED_LOCALES.map((locale) =>
      button({
        namespace: 'lang',
        action: 'set',
        ownerId,
        params: [locale],
        label: LOCALE_META[locale].label,
        emoji: LOCALE_META[locale].flag,
        style: locale === current ? ButtonStyle.Secondary : ButtonStyle.Primary,
        disabled: locale === current,
      }),
    ),
  );
}

/**
 * Applique la nouvelle langue et répond. Partagé entre la commande et le bouton,
 * pour qu'ils ne puissent pas diverger.
 */
export async function applyLocale(
  interaction: RepliableInteraction,
  context: CommandContext,
  locale: SupportedLocale,
  options: { edit?: boolean } = {},
): Promise<void> {
  await playerRepo.updateSettings(context.player.id, { locale });
  // Le contexte en mémoire est mis à jour pour que la suite de CETTE interaction
  // (embeds, images) parle déjà la nouvelle langue.
  context.player.locale = locale;
  context.locale = locale;

  const payload = {
    embeds: [confirmationEmbed(locale)],
    components: [localeRow(interaction.user.id, locale)],
  };

  if (options.edit) {
    await interaction.editReply(payload);
    return;
  }
  await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

const lang: Command = {
  category: 'demarrage',
  cooldown: { seconds: 3 },
  data: new SlashCommandBuilder()
    .setName('lang')
    .setDescription("Changer la langue de l'interface · Change the interface language")
    .addStringOption((option) =>
      option
        .setName('language')
        .setNameLocalization('en-US', 'language')
        .setDescription('Langue souhaitée · Desired language')
        .addChoices(
          ...SUPPORTED_LOCALES.map((locale) => ({
            name: `${LOCALE_META[locale].flag} ${LOCALE_META[locale].label}`,
            value: locale,
          })),
        ),
    )
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    const requested = interaction.options.getString('language');

    // Sans option : on montre l'état courant et on laisse choisir par bouton.
    if (!requested) {
      const current = isSupported(context.locale) ? context.locale : 'fr';
      const meta = LOCALE_META[current];
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: `${meta.flag} ${translate(current, 'settings.language_title')}`,
            description: translate(current, 'settings.language_current', { language: meta.native }),
            color: COLORS.info,
          }),
        ],
        components: [localeRow(interaction.user.id, current)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // La valeur vient d'une liste de choix fermée, mais on revalide : une
    // interaction peut être forgée, et `SUPPORTED_LOCALES` peut évoluer.
    if (!isSupported(requested)) {
      const current = isSupported(context.locale) ? context.locale : 'fr';
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: translate(current, 'settings.language_unknown_title'),
            description: translate(current, 'settings.language_unknown_body', {
              locales: SUPPORTED_LOCALES.join(', '),
            }),
            color: COLORS.danger,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await applyLocale(interaction, context, requested);
  },
};

export const commands: Command[] = [lang];
export { LOCALE_META, isSupported, localeRow };
