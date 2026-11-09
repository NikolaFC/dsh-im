import { randomBytes } from 'node:crypto';
import { workspacePathSnapshot } from '../shared/workspace-command.mjs';

export const PICKER_COMMANDS = new Set(['model', 'reasoning', 'permission', 'preset', 'ws', 'workspace']);
const idArg = value => /^\d+$/.test(value) ? `id:${value}` : value;
const safeArg = value => typeof value === 'string' && value.length > 0 && !/[\r\n\0]/.test(value);
export const boundedDiscordContent = text => text.length <= 2000 ? text : `${text.slice(0, 1960)}\n…（结果较长，已截断）`;

/** Read the same scoped Host catalogs as the text commands; never mutate them. */
export async function discordCommandChoices(command, harness, state, key, signal) {
  const options = { signal };
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

export class DiscordCommandPickers {
  #entries = new Map();
  issue(message, choices, sessionId) {
    const clean = choices.filter(item => safeArg(item?.label) && safeArg(item?.command));
    if (!clean.length) return null;
    const nonce = randomBytes(12).toString('base64url');
    const items = clean.slice(0, 25);
    const now = Date.now();
    for (const [key, entry] of this.#entries) if (entry.expires < now) this.#entries.delete(key);
    while (this.#entries.size >= 256) this.#entries.delete(this.#entries.keys().next().value);
    this.#entries.set(nonce, { actor: message.senderId, route: `${message.kind}:${message.conversationId}`, sessionId,
      expires: now + 10 * 60_000, items, claimed: false });
    return { content: `选一个：${clean.length > 25 ? `（仅显示前 25 项，共 ${clean.length} 项；其他选项请用文字命令）` : ''}`,
      components: [{ type: 1, components: [{ type: 3, custom_id: `dc1|${nonce}`, min_values: 1, max_values: 1,
        options: items.map((item, index) => ({ label: item.label.slice(0, 100), value: String(index) })) }] }] };
  }
  belongsTo(message) {
    const nonce = /^dc1\|([A-Za-z0-9_-]{16})$/.exec(message.data ?? '')?.[1];
    const entry = this.#entries.get(nonce);
    return Boolean(entry && entry.actor === message.senderId
      && entry.route === `${message.kind}:${message.conversationId}`);
  }
  claim(message, sessionId) {
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
