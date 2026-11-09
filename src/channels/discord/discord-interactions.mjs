import { harnessQuestionText } from '../shared/harness-question.mjs';
import { t } from '../shared/i18n.mjs';
import { TelegramApprovalCard, parseTelegramApprovalCallback } from '../telegram/approval-card.mjs';

export const DISCORD_COMMAND_GUILD = '1468696024829792310';
const COMMANDS = [
  ['help', '查看命令', false], ['models', '列出模型', false],
  ['model', '查看或切换模型', true], ['reasoning', '查看或切换推理等级', true],
  ['reasoninglist', '列出推理等级', false], ['status', '查看会话状态', false],
  ['stop', '停止当前任务', false], ['new', '新建会话', true],
  ['ws', '查看或切换工作区', true],
  ['permission', '查看或切换权限档位', true], ['steer', '纠偏当前任务', true],
  ['compact', '压缩当前会话', false], ['presets', '列出 Agent Preset', false],
  ['preset', '查看或切换 Agent Preset', true],
];
export const DISCORD_APPLICATION_COMMANDS = COMMANDS.map(([name, description, args]) => ({
  type: 1, name, description: `DSH · ${description}`,
  ...(args ? { options: [{ type: 3, name: 'input', description: '命令参数（与文字命令相同）', required: false, max_length: 1000 }] } : {}),
}));

/** Upsert only this adapter's guild commands; never bulk overwrite or delete. */
export async function syncDiscordCommands(api, applicationId, signal) {
  const scope = { applicationId, guildId: DISCORD_COMMAND_GUILD, signal };
  const existing = await api.listApplicationCommands(scope);
  if (!Array.isArray(existing)) throw new TypeError('Invalid Discord command directory');
  const result = { created: [], updated: [], collisions: [] };
  for (const command of DISCORD_APPLICATION_COMMANDS) {
    const prior = existing.find(item => item.type === 1 && item.name === command.name);
    if (prior && !prior.description?.startsWith('DSH · ')) {
      result.collisions.push(command.name);
      continue;
    }
    if (!prior) {
      await api.createApplicationCommand({ ...scope, command });
      result.created.push(command.name);
    } else if (prior.description !== command.description
      || JSON.stringify(prior.options ?? []) !== JSON.stringify(command.options ?? [])) {
      await api.editApplicationCommand({ ...scope, commandId: prior.id, command });
      result.updated.push(command.name);
    }
  }
  return result;
}

export function discordCommandText(data) {
  const definition = DISCORD_APPLICATION_COMMANDS.find(item => item.name === data?.name);
  if (!definition || data.type !== 1) return null;
  const options = data.options ?? [];
  if (!Array.isArray(options) || options.length > 1) return null;
  const input = options[0];
  if (input && (!definition.options || input.name !== 'input' || input.type !== 3
    || typeof input.value !== 'string' || input.value.length > 1000 || /[\r\n\0]/.test(input.value))) return null;
  return `/${definition.name}${input?.value?.trim() ? ` ${input.value.trim()}` : ''}`;
}

export function normalizeDiscordInteraction(interaction, applicationId) {
  const actor = interaction?.member?.user ?? interaction?.user;
  if (String(interaction?.application_id) !== String(applicationId)
    || !interaction?.id || !interaction?.token || !interaction?.channel_id
    || !actor?.id || actor.bot === true
    || (interaction.guild_id && interaction.guild_id !== DISCORD_COMMAND_GUILD)) return null;
  const common = {
    messageId: String(interaction.id), senderId: String(actor.id), senderIsBot: false,
    kind: interaction.guild_id ? 'group' : 'direct', conversationId: String(interaction.channel_id),
    addressed: true, requiresMention: false, plainText: true,
    replyTarget: { channelId: String(interaction.channel_id) },
  };
  if (interaction.type === 2) {
    const content = discordCommandText(interaction.data);
    return content ? { ...common, content, images: [], files: [] } : null;
  }
  if (interaction.type !== 3 || !interaction.message?.id
    || String(interaction.message.author?.id) !== String(applicationId)) return null;
  return {
    ...common, data: interaction.data?.custom_id, values: interaction.data?.values,
    componentType: interaction.data?.component_type,
    providerMessageId: String(interaction.message.id),
    callbackQueryId: { applicationId, token: interaction.token },
  };
}

export const DISCORD_INTERACTION_CARD = Object.freeze({
  render(question, { questionIndex = 0, total = 1, nonce, requiresMention = false } = {}) {
    const options = question?.options;
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(nonce ?? '') || !Array.isArray(options)
      || options.length < 1 || options.length > 25
      || options.some(option => typeof option?.label !== 'string' || !option.label.trim()
        || option.label.length > 100)) return null;
    const text = harnessQuestionText(question, questionIndex, total, { requiresMention, hasButtons: true });
    if (text.length > 1900) return null;
    return { text, markup: { components: [{ type: 1, components: [{
      type: 3, custom_id: `dq1|${nonce}|${questionIndex}`, min_values: 1,
      max_values: question.multiSelect === true ? options.length : 1,
      options: options.map((option, index) => ({ label: option.label, value: String(index) })),
    }] }] } };
  },
  parse(data, callback) {
    const match = /^dq1\|([A-Za-z0-9_-]{1,16})\|(\d{1,4})$/.exec(data ?? '');
    const values = callback?.values;
    if (!match || callback?.componentType !== 3 || !Array.isArray(values)
      || values.length < 1 || values.length > 25 || new Set(values).size !== values.length
      || values.some(value => typeof value !== 'string' || !/^(0|[1-9]\d?)$/.test(value))) return null;
    return { nonce: match[1], questionIndex: Number(match[2]), optionIndexes: values.map(Number) };
  },
});

/** Reuse the existing approval queue controller, converting only presentation. */
export class DiscordApprovalCard extends TelegramApprovalCard {
  createContext(context) {
    const bot = context?.bot;
    if (!bot) return {};
    const wrappedBot = {
      sendInteractionCard: async (target, card) => {
        const sent = await bot.sendInteractionCard(target, card);
        const parsed = parseTelegramApprovalCallback(card.markup?.inline_keyboard?.[0]?.[0]?.callback_data);
        const entry = parsed && this.registry.get(parsed.nonce);
        if (entry) entry.payload.providerMessageId = sent?.providerMessageIds?.at(-1);
        return sent;
      },
      editInteractionCard: (...args) => bot.editInteractionCard(...args),
      updateInteractionCard: (...args) => bot.updateInteractionCard(...args),
    };
    return super.createContext({ ...context, bot: wrappedBot });
  }

  async handlePress(callback, options) {
    const parsed = parseTelegramApprovalCallback(callback?.data);
    if (!parsed) return false;
    const entry = this.registry.get(parsed.nonce);
    if (entry && (entry.conversationKey !== `${callback.kind}:${callback.conversationId}`
      || (entry.payload.providerMessageId && entry.payload.providerMessageId !== callback.providerMessageId))) {
      await options.answer?.(t('这个选项已失效，请使用最新一条问题。'));
      return true;
    }
    return super.handlePress(callback, options);
  }
}

export function discordCardComponents(markup) {
  if (Array.isArray(markup?.components)) return markup.components;
  const rows = markup?.inline_keyboard ?? [];
  if (!Array.isArray(rows) || rows.length > 5) throw new TypeError('Invalid Discord card rows');
  return rows.map(row => ({ type: 1, components: row.map(button => ({
    type: 2, style: button.callback_data?.endsWith('|d') ? 4 : 3,
    label: button.text, custom_id: button.callback_data,
  })) }));
}
