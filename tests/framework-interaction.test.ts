import { MessageFlags } from 'discord.js';
import type { Interaction, RepliableInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { isEcoBanExempt, replyEphemeral, replyError } from '../src/framework/interaction';
import { gameError } from '../src/utils/errors';

/**
 * Pipeline d'interaction : les deux décisions que le joueur subit directement,
 * et qu'aucun test ne couvrait.
 *
 *  1. Qui échappe au bannissement économique ? La garde ne lisait que
 *     `commandName`, absent d'un bouton : tout composant était refusé, y compris
 *     la confirmation de suppression de compte (RGPD).
 *  2. Où atterrit un message d'erreur ? Après un `deferUpdate()` de composant,
 *     `@original` est le message porteur de la vue : le supprimer effaçait
 *     /farm, /animals ou un échange partagé à la moindre `GameError`.
 *
 * Aucune base, aucun Discord : de fausses interactions suffisent, ce sont les
 * seuls champs que le code lit (`deferred`, `ephemeral`, `customId`).
 */

function chatInputInteraction(commandName: string): Interaction {
  return {
    isChatInputCommand: () => true,
    isMessageComponent: () => false,
    isModalSubmit: () => false,
    commandName,
  } as unknown as Interaction;
}

function componentInteraction(customId: string): Interaction {
  return {
    isChatInputCommand: () => false,
    isMessageComponent: () => true,
    isModalSubmit: () => false,
    customId,
  } as unknown as Interaction;
}

describe('bannissement économique : périmètre de la garde', () => {
  it('laisse passer les commandes en lecture seule et refuse les autres', () => {
    expect(isEcoBanExempt(chatInputInteraction('account'))).toBe(true);
    expect(isEcoBanExempt(chatInputInteraction('profile'))).toBe(true);
    expect(isEcoBanExempt(chatInputInteraction('shop'))).toBe(false);
  });

  it('laisse un joueur sanctionné confirmer la suppression de son compte', () => {
    // Le scénario du bug : `/account delete` affichait l'avertissement (commande
    // en liste blanche) mais le clic sur « Delete permanently » répondait
    // `errors.player.eco_banned`. Le droit à l'effacement ne peut pas être
    // suspendu 7 à 30 jours par une sanction de jeu.
    expect(isEcoBanExempt(componentInteraction('account:confirm_delete:123456789:1756800000'))).toBe(
      true,
    );
    expect(isEcoBanExempt(componentInteraction('account:cancel_delete:123456789'))).toBe(true);
  });

  it('laisse paginer les vues en lecture seule', () => {
    expect(isEcoBanExempt(componentInteraction('history:page:123456789:2:all:7'))).toBe(true);
    expect(isEcoBanExempt(componentInteraction('collection:page:123456789:2:crops'))).toBe(true);
    expect(isEcoBanExempt(componentInteraction('almanac:refresh:123456789'))).toBe(true);
  });

  it('refuse les composants qui agissent sur l’économie', () => {
    // `almanac:buy` dépense des pièces : c'est exactement ce que la sanction
    // doit couper, même si le namespace `almanac` est par ailleurs consultable.
    expect(isEcoBanExempt(componentInteraction('almanac:buy:123456789:2026-09-03:120'))).toBe(false);
    expect(isEcoBanExempt(componentInteraction('farm:harvest_all:123456789'))).toBe(false);
    expect(isEcoBanExempt(componentInteraction('trade:confirm:123456789:abc'))).toBe(false);
  });

  it('refuse un custom_id malformé plutôt que de lever', () => {
    expect(isEcoBanExempt(componentInteraction('nimportequoi'))).toBe(false);
  });
});

interface FakeInteraction {
  interaction: RepliableInteraction;
  deleteReply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
}

function fakeRepliable(state: {
  deferred: boolean;
  replied?: boolean;
  ephemeral: boolean | null;
}): FakeInteraction {
  const deleteReply = vi.fn(() => Promise.resolve(undefined));
  const followUp = vi.fn(() => Promise.resolve(undefined));
  const editReply = vi.fn(() => Promise.resolve(undefined));
  const reply = vi.fn(() => Promise.resolve(undefined));
  const interaction = {
    deferred: state.deferred,
    replied: state.replied ?? false,
    ephemeral: state.ephemeral,
    locale: 'fr',
    user: { id: '123456789' },
    deleteReply,
    followUp,
    editReply,
    reply,
  } as unknown as RepliableInteraction;
  return { interaction, deleteReply, followUp, editReply, reply };
}

describe('replyEphemeral : ne jamais détruire la vue d’un composant', () => {
  it('après un deferUpdate() de composant, ne supprime rien et complète en éphémère', async () => {
    // `deferUpdate()` laisse `ephemeral` à `null` (seul `deferReply` le
    // renseigne) : `@original` EST le message porteur des boutons.
    const fake = fakeRepliable({ deferred: true, ephemeral: null });

    await replyEphemeral(fake.interaction, { content: 'oups' });

    expect(fake.deleteReply).not.toHaveBeenCalled();
    expect(fake.editReply).not.toHaveBeenCalled();
    expect(fake.followUp).toHaveBeenCalledWith({ content: 'oups', flags: MessageFlags.Ephemeral });
  });

  it('résorbe le placeholder public d’un deferReply() et répond en éphémère', async () => {
    const fake = fakeRepliable({ deferred: true, ephemeral: false });

    await replyEphemeral(fake.interaction, { content: 'oups' });

    expect(fake.deleteReply).toHaveBeenCalledTimes(1);
    expect(fake.followUp).toHaveBeenCalledWith({ content: 'oups', flags: MessageFlags.Ephemeral });
  });

  it('édite simplement une réponse différée déjà éphémère', async () => {
    const fake = fakeRepliable({ deferred: true, ephemeral: true });

    await replyEphemeral(fake.interaction, { content: 'oups' });

    expect(fake.deleteReply).not.toHaveBeenCalled();
    expect(fake.editReply).toHaveBeenCalledTimes(1);
  });

  it('répond directement quand rien n’a encore été envoyé', async () => {
    const fake = fakeRepliable({ deferred: false, ephemeral: null });

    await replyEphemeral(fake.interaction, { content: 'oups' });

    expect(fake.deleteReply).not.toHaveBeenCalled();
    expect(fake.reply).toHaveBeenCalledWith({ content: 'oups', flags: MessageFlags.Ephemeral });
  });
});

describe('replyError sur un composant déféré par deferUpdate()', () => {
  it('laisse le message /animals en place quand « Nourrir tout » échoue', async () => {
    // Chemin réel : buttons/main.ts fait `deferUpdate()` puis `feed({all:true})`
    // lève `animal_not_hungry`. Avant correction, l'erreur supprimait le message
    // /animals du salon (et, pour /trade, celui partagé par deux joueurs).
    const fake = fakeRepliable({ deferred: true, ephemeral: null });

    const report = await replyError(
      fake.interaction,
      gameError('animal_not_hungry', 'No hungry animal.', {
        i18nKey: 'errors.animal.none_hungry',
      }),
    );

    expect(report.code).toBe('animal_not_hungry');
    expect(fake.deleteReply).not.toHaveBeenCalled();
    expect(fake.followUp).toHaveBeenCalledTimes(1);
  });
});
