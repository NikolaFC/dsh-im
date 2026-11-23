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
DISCORD_APPLICATION_COMMANDS.push({ type: 1, name: 'goal', description: 'DSH · 查看或管理当前会话目标', options: [
  { type: 3, name: 'objective', description: '直接填写要完成的目标（无需选择操作）', required: false, max_length: 1000 },
  { type: 3, name: 'action', description: '可选操作：查看状态、创建、暂停或恢复', required: false,
    choices: [{ name: '查看状态', value: 'status' }, { name: '创建目标', value: 'create' },
      { name: '暂停自动续轮', value: 'pause' }, { name: '恢复自动续轮', value: 'resume' }] },
  { type: 4, name: 'rounds', description: '创建时的自动续轮上限（默认 256）', required: false, min_value: 1, max_value: 256 },
] });

function comparableDiscordOptions(options) {
  // Discord omits required=false in readbacks because false is the API default.
  return JSON.stringify(options ?? [], (key, value) => key === 'required' && value === false ? undefined : value);
}

/** Upsert only this adapter's commands in one scope; never bulk overwrite or delete. */
async function syncDiscordCommandScope(api, scope, commands) {
  const existing = await api.listApplicationCommands(scope);
  if (!Array.isArray(existing)) throw new TypeError('Invalid Discord command directory');
  const result = { created: [], updated: [], collisions: [] };
  for (const command of commands) {
    const prior = existing.find(item => item.type === 1 && item.name === command.name);
    if (prior && !prior.description?.startsWith('DSH · ')) {
      result.collisions.push(command.name);
      continue;
    }
    if (!prior) {
      await api.createApplicationCommand({ ...scope, command });
      result.created.push(command.name);
    } else if (prior.description !== command.description
      || comparableDiscordOptions(prior.options) !== comparableDiscordOptions(command.options)
      || (command.contexts !== undefined && JSON.stringify(prior.contexts ?? null) !== JSON.stringify(command.contexts))
      || (command.integration_types !== undefined
        && JSON.stringify(prior.integration_types ?? null) !== JSON.stringify(command.integration_types))) {
      await api.editApplicationCommand({ ...scope, commandId: prior.id, command });
      result.updated.push(command.name);
    }
  }
  return result;
}

/**
 * Guild commands serve Satoshi Capital. Separate global commands are restricted
 * to the bot's own DMs, so they neither duplicate guild commands nor appear in
 * unrelated servers or user-installed private channels.
 */
export async function syncDiscordCommands(api, applicationId, signal) {
  const guild = await syncDiscordCommandScope(api,
    { applicationId, guildId: DISCORD_COMMAND_GUILD, signal }, DISCORD_APPLICATION_COMMANDS);
  const directCommands = DISCORD_APPLICATION_COMMANDS.map(command => ({
    ...command, contexts: [1], integration_types: [0],
  }));
  const global = await syncDiscordCommandScope(api, { applicationId, signal }, directCommands);
  return {
    created: [...new Set([...guild.created, ...global.created])],
    updated: [...new Set([...guild.updated, ...global.updated])],
    collisions: [...new Set([...guild.collisions, ...global.collisions])],
    guild,
    global,
  };
}

export function discordCommandText(data) {
  const definition = DISCORD_APPLICATION_COMMANDS.find(item => item.name === data?.name);
  if (!definition || data.type !== 1) return null;
  const options = data.options ?? [];
  if (definition.name === 'goal') {
    if (!Array.isArray(options) || options.length > 3 || new Set(options.map(item => item?.name)).size !== options.length) return null;
    const values = {};
    for (const item of options) {
      if (item?.name === 'action' && item.type === 3 && ['status', 'create', 'pause', 'resume'].includes(item.value)) values.action = item.value;
      else if (item?.name === 'objective' && item.type === 3 && typeof item.value === 'string'
        && item.value.trim() && item.value.length <= 1000 && !/[\r\n\0]/u.test(item.value)) values.objective = item.value.trim();
      else if (item?.name === 'rounds' && item.type === 4 && Number.isSafeInteger(item.value) && item.value >= 1 && item.value <= 256) values.rounds = item.value;
      else return null;
    }
    const { action, objective, rounds } = values;
    if (action && action !== 'create') {
      return objective === undefined && rounds === undefined ? `/goal ${action}` : null;
    }
    if (objective === undefined) {
      if (action === 'create') return '/goal create';
      return rounds === undefined ? '/goal' : null;
    }
    // The first field also accepts the short control commands. Explicit create
    // or a round cap leaves those same words available as literal objectives.
    if (action === undefined && rounds === undefined && /^(?:status|create|pause|resume)$/u.test(objective)) {
      return `/goal ${objective}`;
    }
    return `/goal create --rounds ${rounds ?? 256} ${objective}`;
  }
  if (!Array.isArray(options) || options.length > 1) return null;
  const input = options[0];
  if (input && (!definition.options || input.name !== 'input' || input.type !== 3
    || typeof input.value !== 'string' || input.value.length > 1000 || /[\r\n\0]/.test(input.value))) return null;
  return `/${definition.name}${input?.value?.trim() ? ` ${input.value.trim()}` : ''}`;
}

export const DISCORD_GOAL_MODAL_ID = 'dgoal1';

/** Fallback form when a create request provides no objective. */
export function discordGoalModal() {
  return { custom_id: DISCORD_GOAL_MODAL_ID, title: '创建会话目标', components: [
    { type: 1, components: [{ type: 4, custom_id: 'objective', style: 1, label: '目标（具体完成什么）',
      required: true, min_length: 1, max_length: 1000 }] },
    { type: 1, components: [{ type: 4, custom_id: 'rounds', style: 1, label: '自动续轮上限（1–256，留空为 256）',
      required: false, max_length: 3 }] },
  ] };
}

/** Turn a goal form submission into the same text command a person could type. */
export function discordGoalModalText(data) {
  if (data?.custom_id !== DISCORD_GOAL_MODAL_ID || !Array.isArray(data.components)) return null;
  const values = {};
  for (const row of data.components) {
    const inputs = Array.isArray(row?.components) ? row.components : row?.component ? [row.component] : [];
    for (const input of inputs) {
      if (['objective', 'rounds'].includes(input?.custom_id) && typeof input.value === 'string') values[input.custom_id] = input.value;
    }
  }
  // An unusable form still gets an answer: the bare create command replies with the hint.
  const objective = values.objective?.trim();
  if (!objective || objective.length > 1000 || objective.startsWith('--') || /[\r\n\0]/u.test(objective)) return '/goal create';
  const roundsText = values.rounds?.trim() ?? '';
  const rounds = roundsText ? Number(roundsText) : 256;
  if (!/^\d{0,3}$/.test(roundsText) || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 256) return '/goal create';
  return `/goal create --rounds ${rounds} ${objective}`;
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
  if (interaction.type === 5) {
    const content = discordGoalModalText(interaction.data);
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

const CARD_TEXT_LIMIT = 1900;
const SELECT_LABEL_LIMIT = 100;
const SELECT_OPTION_LIMIT = 25;

function canSelect(question) {
  const options = question?.options;
  return Array.isArray(options) && options.length > 0 && options.length <= SELECT_OPTION_LIMIT
    && options.every(option => typeof option?.label === 'string' && !!option.label.trim()
      && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(option.label));
}

function discordSelectLabel(label, index) {
  const text = label.replace(/[\r\n\t]+/g, ' ');
  if (text.length <= SELECT_LABEL_LIMIT) return text;
  // The full original labels stay in the numbered question above the menu.
  // An ordinal distinguishes similar truncations. The wire value stays an index.
  const prefix = `${index + 1}. `;
  const preview = text.slice(0, SELECT_LABEL_LIMIT - prefix.length - 1).replace(/[\ud800-\udbff]$/u, '');
  return `${prefix}${preview}…`;
}

export const DISCORD_INTERACTION_CARD = Object.freeze({
  render(question, { questionIndex = 0, total = 1, nonce, requiresMention = false } = {}) {
    if (!question || !/^[A-Za-z0-9_-]{1,16}$/.test(nonce ?? '')
      || !Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex > 9999) return null;
    const selectable = canSelect(question);
    const skippable = question.intent === undefined;
    const id = `dq1|${nonce}|${questionIndex}`;
    const components = [];
    if (selectable) components.push({ type: 1, components: [{
      type: 3, custom_id: id, min_values: 1,
      max_values: question.multiSelect === true ? question.options.length : 1,
      options: question.options.map((option, index) => ({ label: discordSelectLabel(option.label, index), value: String(index) })),
    }] });
    if (skippable) components.push({ type: 1, components: [{
      type: 2, style: 2, custom_id: `${id}|skip`, label: t('跳过此题'),
    }] });
    if (!components.length) return null;
    const markup = { components };
    const text = harnessQuestionText(question, questionIndex, total, { requiresMention, hasButtons: selectable });
    if (text.length <= CARD_TEXT_LIMIT) return { text, markup };
    return {
      prelude: harnessQuestionText(question, questionIndex, total, { requiresMention }),
      text: selectable ? t('请点击下方按钮选择，也可直接回复文字。') : t('请直接回复你的答案。'),
      markup,
    };
  },
  parse(data, callback) {
    const match = /^dq1\|([A-Za-z0-9_-]{1,16})\|(\d{1,4})(\|skip)?$/.exec(data ?? '');
    if (!match) return null;
    const result = { nonce: match[1], questionIndex: Number(match[2]) };
    const values = callback?.values;
    if (match[3]) return callback?.componentType === 2 && values === undefined ? { ...result, action: 'skip' } : null;
    if (callback?.componentType !== 3 || !Array.isArray(values)
      || values.length < 1 || values.length > SELECT_OPTION_LIMIT || new Set(values).size !== values.length
      || values.some(value => typeof value !== 'string' || !/^(0|[1-9]\d?)$/.test(value)
        || Number(value) >= SELECT_OPTION_LIMIT)) return null;
    return { ...result, optionIndexes: values.map(Number) };
  },
  accepts(question, press) {
    return press.action === 'skip' ? question.intent === undefined : canSelect(question);
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
