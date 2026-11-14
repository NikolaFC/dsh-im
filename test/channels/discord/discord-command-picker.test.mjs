import test from 'node:test';
import assert from 'node:assert/strict';
import { discordCommandChoices, DiscordCommandPickers, boundedDiscordContent } from '../../../src/channels/discord/discord-command-picker.mjs';
import { DiscordBotClient, DiscordRuntime } from '../../../src/channels/discord/discord-runtime.mjs';
import { DISCORD_COMMAND_GUILD } from '../../../src/channels/discord/discord-interactions.mjs';

test('pickers use actual model, reasoning, preset and permission catalogs', async () => {
  const catalog = { current: { provider: 'p', model: 'm' }, groups: [{ id: 'p', models: [{ id: 'm', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] };
  const harness = { workspaceSession: () => ({ models: async () => catalog, permissions: async () => ({ options: [{ value: 'custom' }, { value: '2', name: 'Reviewed' }] }) }),
    agentPresetSettings: async () => ({ agentPresetCatalog: { items: [{ id: '3', label: 'Actual' }] } }) };
  const state = { sessionFor: () => 's' };
  assert.equal((await discordCommandChoices('model', harness, state, 'g'))[0].command, '/model p/m');
  assert.equal((await discordCommandChoices('reasoning', harness, state, 'g'))[0].command, '/reasoning high');
  assert.equal((await discordCommandChoices('preset', harness, state, 'g'))[0].command, '/preset id:3');
  assert.equal((await discordCommandChoices('permission', harness, state, 'g'))[0].command, '/permission id:2');
});

test('picker bounds and identity checks reject wrong actor, route, session and replay', () => {
  const pickers = new DiscordCommandPickers();
  const message = { senderId: 'owner', kind: 'group', conversationId: 'c' };
  const card = pickers.issue(message, Array.from({ length: 30 }, (_, i) => ({ label: `Choice ${i}`, command: `/model p/${i}` })), 's');
  assert.match(card.content, /25.*30/);
  const component = card.components[0].components[0];
  assert.equal(component.options.length, 25);
  const press = { ...message, data: component.custom_id, componentType: 3, values: ['1'] };
  assert.equal(pickers.belongsTo({ ...press, senderId: 'stranger' }), false);
  assert.equal(pickers.belongsTo(press), true);
  assert.equal(pickers.claim({ ...press, senderId: 'stranger' }, 's'), null);
  assert.equal(pickers.claim({ ...press, conversationId: 'other' }, 's'), null);
  assert.equal(pickers.claim(press, 'changed'), null);
  assert.equal(pickers.claim(press, 's'), '/model p/1');
  assert.equal(pickers.claim(press, 's'), null);
  assert.ok(boundedDiscordContent('a'.repeat(3000)).length <= 2000);
});

test('help panel bounds and one-shot buttons share picker identity discipline', () => {
  const registry = new DiscordCommandPickers();
  const owner = { senderId: 'owner', kind: 'group', conversationId: 'channel' };
  const panel = registry.issueHelp(owner, 's');
  const buttons = panel.components.flatMap(row => row.components);
  assert.equal(buttons.length, 14);
  assert.ok(buttons.some(button => button.custom_id.startsWith('dbtn|goal|')));
  assert.ok(panel.components.every(row => row.components.length <= 5));
  assert.ok(buttons.every(button => button.type === 2 && button.custom_id.startsWith('dbtn|')));
  const press = { ...owner, componentType: 2, data: buttons.find(button => button.custom_id.startsWith('dbtn|model|')).custom_id };
  assert.equal(registry.claim({ ...press, senderId: 'stranger' }, 's'), null);
  assert.equal(registry.claim(press, 's'), '/model');
  assert.equal(registry.claim(press, 's'), null);
});

test('command reply edits the same interaction and visibly truncates long output', async () => {
  const calls = [];
  const bot = new DiscordBotClient({ api: { editOriginalInteraction: async args => { calls.push(args); return { id: 'm' }; } } });
  const target = { interactionResponse: { applicationId: 'app', token: 'token' } };
  await bot.sendText(target, 'first');
  await bot.sendText(target, 'x'.repeat(2500));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].token, 'token');
  assert.match(calls[1].content, /^first/);
  assert.match(calls[1].content, /已截断/);
});

test('runtime help hands off to picker or execution and falls back to text', async () => {
  const app = '123456789012345678'; const calls = []; const listeners = new Map();
  let failPanel = false;
  const socket = { readyState: 1, addEventListener: (name, fn) => listeners.set(name, fn),
    send: raw => { if (JSON.parse(raw).op === 2) queueMicrotask(() => listeners.get('message')({ data: JSON.stringify({ op: 0, t: 'READY', d: { session_id: 's' } }) })); }, close() {} };
  const runtime = new DiscordRuntime({ config: { platformId: app, botId: 'test' }, token: 'test',
    harness: { ensureRunning: async () => true, listModels: async () => { calls.push(['catalog']); return { groups: [{ id: 'p', models: [{ id: 'm' }] }] }; } },
    state: { hasSeen: () => false, sessionFor: () => null, markSeen: async () => {} },
    createApi: () => ({ getCurrentUser: async () => ({ id: app, bot: true }), getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
      respondInteraction: async args => calls.push(['ack', args]), editOriginalInteraction: async args => {
        if (failPanel && args.components?.[0]?.components?.[0]?.type === 2) throw new Error('panel rejected');
        calls.push(['edit', args]); return { id: 'message' };
      },
      createMessage: async () => assert.fail('no stray channel message') }),
    createWebSocket: () => { queueMicrotask(() => listeners.get('message')({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) })); return socket; },
  });
  try {
    await runtime.start();
    let seq = 0;
    const emit = overrides => listeners.get('message')({ data: JSON.stringify({ op: 0, t: 'INTERACTION_CREATE', d: {
      id: String(223456789012345678n + BigInt(seq++)), token: 'test', application_id: app,
      guild_id: DISCORD_COMMAND_GUILD, channel_id: '323456789012345678', member: { user: { id: 'owner' } },
      type: 2, data: { name: 'help', type: 1 }, ...overrides,
    } }) });
    const wait = async count => { for (let i = 0; i < 100 && calls.length < count; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(calls.length >= count); };
    emit({}); await wait(2);
    assert.equal(calls[0][1].type, 5);
    assert.equal(calls[0][1].data.flags, 64);
    const panel = calls[1][1];
    const button = command => panel.components.flatMap(row => row.components).find(item => item.custom_id.startsWith(`dbtn|${command}|`));
    const press = command => ({ type: 3, message: { id: 'message', author: { id: app } }, data: { custom_id: button(command).custom_id, component_type: 2 } });
    emit(press('model')); await wait(5);
    assert.deepEqual(calls.slice(2).map(call => call[0]), ['ack', 'catalog', 'edit']);
    assert.equal(calls[4][1].components[0].components[0].options[0].label, 'p / m');
    emit({}); await wait(7);
    const nextPanel = calls[6][1];
    const listButton = nextPanel.components.flatMap(row => row.components).find(item => item.custom_id.startsWith('dbtn|reasoninglist|'));
    emit({ type: 3, message: { id: 'message', author: { id: app } }, data: { custom_id: listButton.custom_id, component_type: 2 } });
    await wait(9);
    assert.equal(calls[8][0], 'edit');
    assert.equal(calls[8][1].components, undefined);
    failPanel = true;
    emit({}); await wait(11);
    assert.match(calls.at(-1)[1].content, /按钮面板暂不可用/);
  } finally { await runtime.stop(); }
});
