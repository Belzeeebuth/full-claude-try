import { SlashCommandBuilder } from 'discord.js';
import { COLORS, baseEmbed, successEmbed } from '../framework/ui';
import { NO_IMAGE, renderMiningImage } from '../render';
import * as miningService from '../services/mining.service';
import { formatCoins } from '../utils/format';
import type { Command } from '../types';

const mine: Command = {
  category: 'agriculture',
  cooldown: { seconds: 5 },
  data: new SlashCommandBuilder()
    .setName('mine')
    .setDescription('Swing your pickaxe and see what the depths give up')
    .toJSON(),

  async execute(interaction, context): Promise<void> {
    await interaction.deferReply();

    const result = await miningService.dig(context.player, context.now);
    const status = await miningService.getStatus(context.player);
    const image = context.player.compactMode
      ? NO_IMAGE
      : await renderMiningImage({
          locale: context.locale,
          depth: result.depth,
          maxDepth: result.maxDepth,
          deepestReached: status.deepestReached,
        });

    const lines: string[] = [
      result.ore
        ? context.t('mining.found_body', {
            emoji: result.ore.emoji,
            name: result.ore.name,
            value: formatCoins(result.ore.value, false, context.locale),
          })
        : context.t('mining.nothing_body'),
    ];
    if (result.advanced) {
      lines.push(context.t('mining.advance_body', { depth: result.depth }));
    } else if (result.depth >= result.maxDepth) {
      lines.push(context.t('mining.max_depth_body'));
    }

    const embed = result.ore
      ? successEmbed(context.t('mining.dig_title'), lines.join('\n'))
      : baseEmbed({
          title: context.t('mining.dig_title'),
          description: lines.join('\n'),
          color: COLORS.info,
        });
    embed.addFields({
      name: context.t('mining.depth_field'),
      value: `${result.depth} / ${result.maxDepth}`,
      inline: true,
    });

    await interaction.editReply({
      embeds: [embed],
      files: image.attachment ? [image.attachment] : [],
    });
  },
};

export const commands: Command[] = [mine];
