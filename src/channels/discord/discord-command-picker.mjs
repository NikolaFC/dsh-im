import { randomBytes } from 'node:crypto';
import { workspacePathSnapshot } from '../shared/workspace-command.mjs';
import { GOAL_CREATE_HINT, runGoalCommand } from '../shared/goal-command.mjs';
import { t } from '../shared/i18n.mjs';

export const PICKER_COMMANDS = new Set(['model', 'reasoning', 'permission', 'preset', 'ws', 'workspace', 'goal']);
const idArg = value => /^\d+$/.test(value) ? `id:${value}` : value;
const safeArg = value => typeof value === 'string' && value.length > 0 && !/[\r\n\0]/.test(value);
export const boundedDiscordContent = text => text.length <= 2000 ? text : `${text.slice(0, 1960)}\n…（结果较长，已截断）`;

/** Read the same scoped Host catalogs as the text commands; never mutate them. */
export async function discordCommandChoices(command, harness, state, key, signal) {
  const options = { signal };
  if (command === 'goal') {
    const status = await runGoalCommand('/goal status', harness, state, key, options);
    const goal = status?.goal;
    const bound = typeof state?.sessionFor === 'function' && Boolean(state.sessionFor(key));
    const choices = [{ label: '查看目标状态', command: '/goal status' }];
    if (!goal || goal.phase === 'complete') choices.push({ label: '创建目标（弹出表单填写）', command: '/goal create' });
    if (goal?.phase === 'active') choices.push({ label: '暂停自动续轮', command: '/goal pause' });
    if (goal && goal.phase !== 'complete' && goal.roundsStarted < goal.maxGoalRounds
      && (goal.phase !== 'active' || goal.activation !== 'armed')) choices.push({ label: '恢复自动续轮', command: '/goal resume' });
    // A fresh conversation has no Session yet; saying how to create the goal is
    // more useful than leaving the unbound notice as the only instruction.
    return {
      content: bound
        ? status.message
        : `${status.message}\n\n${t(GOAL_CREATE_HINT)}`,
      choices,
    };
  }
  if (command === 'preset') {
    const settings = await harness.agentPresetSettings(options);
    return (settings.agentPresetCatalog?.items ?? []).map(item => ({ label: item.label || item.id, command: `/preset ${idArg(item.id)}` }));
  }
  if (command === 'ws' || command === 'workspace') {
    const snapshot = await workspacePathSnapshot(harness, { includeTitles: true, conversationKey: key, signal });
    return snapshot.paths.map(path => ({ label: snapshot.titles?.[path] || path, command: `/ws ${path}` }));
  }
  const sessionId = state.sessionFor(key);
  const session = sessionId ? harness.workspaceSession?.(sessionId, key) : null;
  if (command === 'permission') {
    if (!session?.permissions) return [];
    const permissions = await session.permissions(options);
    return (permissions.options ?? []).filter(item => item.value !== 'custom')
      .map(item => ({ label: item.name || item.value, command: `/permission ${idArg(item.value)}` }));
  }
  const catalog = session?.models ? await session.models(options) : await harness.listModels(options);
  if (command === 'model') return (catalog.groups ?? []).flatMap(group => (group.models ?? [])
    .map(model => ({ label: `${group.name || group.id} / ${model.name || model.id}`, command: `/model ${group.id}/${model.id}` })));
  if (command === 'reasoning') {
    const current = catalog.current;
    const model = catalog.groups?.find(group => group.id === current?.provider)?.models?.find(model => model.id === current?.model);
    return (model?.reasoning?.efforts ?? []).map(effort => ({ label: effort.name || effort.id, command: `/reasoning ${effort.id}` }));
  }
  return [];
}

export const DISCORD_HELP_BUTTONS = Object.freeze([
  ['status', '状态'], ['models', '模型列表'], ['model', '切换模型'], ['reasoning', '推理等级'],
  ['reasoninglist', '等级列表'], ['permission', '权限'], ['preset', '切换预设'], ['presets', '预设列表'],
  ['ws', '工作区'], ['goal', '会话目标'], ['steer', '补充指令'], ['compact', '压缩上下文'], ['new', '新会话'], ['stop', '停止'],
]);

export class DiscordCommandPickers {
  #entries = new Map();
  issue(message, choices, sessionId, summary) {
    const clean = choices.filter(item => safeArg(item?.label) && safeArg(item?.command));
    if (!clean.length) return null;
    const nonce = randomBytes(12).toString('base64url');
    const items = clean.slice(0, 25);
    const now = Date.now();
    for (const [key, entry] of this.#entries) if (entry.expires < now) this.#entries.delete(key);
    while (this.#entries.size >= 256) this.#entries.delete(this.#entries.keys().next().value);
    this.#entries.set(nonce, { actor: message.senderId, route: `${message.kind}:${message.conversationId}`, sessionId,
      expires: now + 10 * 60_000, items, claimed: false });
    return { content: summary ? boundedDiscordContent(summary) : `选一个：${clean.length > 25 ? `（仅显示前 25 项，共 ${clean.length} 项；其他选项请用文字命令）` : ''}`,
      components: [{ type: 1, components: [{ type: 3, custom_id: `dc1|${nonce}`, min_values: 1, max_values: 1,
        options: items.map((item, index) => ({ label: item.label.slice(0, 100), value: String(index) })) }] }] };
  }
  issueHelp(message, sessionId) {
    const card = this.issue(message, DISCORD_HELP_BUTTONS.map(([command, label]) => ({ label, command: `/${command}` })), sessionId);
    const nonce = card.components[0].components[0].custom_id.split('|')[1];
    const entry = this.#entries.get(nonce);
    entry.help = true;
    const buttons = DISCORD_HELP_BUTTONS.map(([command, label]) => ({ type: 2, style: 2, label, custom_id: `dbtn|${command}|${nonce}` }));
    return { content: '点一个命令：', components: Array.from({ length: Math.ceil(buttons.length / 5) }, (_, index) => ({ type: 1, components: buttons.slice(index * 5, index * 5 + 5) })) };
  }
  belongsTo(message) {
    const nonce = /^dc1\|([A-Za-z0-9_-]{16})$/.exec(message.data ?? '')?.[1]
      ?? /^dbtn\|[a-z]+\|([A-Za-z0-9_-]{16})$/.exec(message.data ?? '')?.[1];
    const entry = this.#entries.get(nonce);
    return Boolean(entry && entry.actor === message.senderId
      && entry.route === `${message.kind}:${message.conversationId}`);
  }
  claim(message, sessionId) {
    const button = /^dbtn\|([a-z]+)\|([A-Za-z0-9_-]{16})$/.exec(message.data ?? '');
    if (button) {
      const entry = this.#entries.get(button[2]);
      if (!entry?.help || entry.claimed || entry.expires < Date.now() || !this.belongsTo(message)
        || entry.sessionId !== sessionId || message.componentType !== 2
        || !entry.items.some(item => item.command === `/${button[1]}`)) return null;
      entry.claimed = true;
      return `/${button[1]}`;
    }
    const match = /^dc1\|([A-Za-z0-9_-]{16})$/.exec(message.data ?? '');
    const entry = match && this.#entries.get(match[1]);
    const values = message.values;
    if (!entry || entry.claimed || entry.expires < Date.now() || entry.actor !== message.senderId
      || entry.route !== `${message.kind}:${message.conversationId}` || entry.sessionId !== sessionId
      || message.componentType !== 3 || !Array.isArray(values) || values.length !== 1
      || !/^(0|[1-9]\d?)$/.test(values[0]) || !entry.items[Number(values[0])]) return null;
    entry.claimed = true;
    return entry.items[Number(values[0])].command;
  }
}
