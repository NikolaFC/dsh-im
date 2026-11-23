import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHarnessCommandExecutor } from '../../../plugin-src/host/harness-command-executor.mjs';
import { harnessConnection } from '../../../plugin-src/host/harness-connection.mjs';
import { DISCORD_COMMAND_GUILD, DISCORD_APPLICATION_COMMANDS, syncDiscordCommands,
  discordCommandText, normalizeDiscordInteraction, DISCORD_INTERACTION_CARD,
  DiscordApprovalCard, discordCardComponents, discordGoalModal } from '../../../src/channels/discord/discord-interactions.mjs';
import { DiscordHarnessBridge } from '../../../src/channels/discord/discord-bridge.mjs';
import { DiscordApi } from '../../../src/channels/discord/discord-api.mjs';
import { DiscordBotClient, DiscordRuntime } from '../../../src/channels/discord/discord-runtime.mjs';
import { DiscordHarnessClient } from '../../../src/channels/discord/harness-client.mjs';
import { DiscordStateStore } from '../../../src/channels/discord/state-store.mjs';
import { TELEGRAM_INTERACTION_CARD } from '../../../src/channels/telegram/telegram-bridge.mjs';
import { BotWorkspaceStore, createBotWorkspaceScope } from '../../../src/channels/shared/bot-workspace-store.mjs';
import { directAccessPolicy } from '../access-policy-fixture.mjs';

const app = '123456789012345678';
const event = { id: '223456789012345678', token: 'test_token', application_id: app,
  guild_id: DISCORD_COMMAND_GUILD, channel_id: '323456789012345678',
  member: { user: { id: '423456789012345678' } }, type: 2,
  data: { type: 1, name: 'model', options: [{ name: 'input', type: 3, value: 'provider/model' }] } };

test('slash normalizer preserves channel/actor and only accepts known bounded commands', () => {
  const message = normalizeDiscordInteraction(event, app);
  assert.equal(message.content, '/model provider/model');
  assert.equal(message.conversationId, event.channel_id);
  assert.equal(message.senderId, event.member.user.id);
  assert.equal(message.replyTarget.replyToMessageId, undefined);
  const direct = normalizeDiscordInteraction({ ...event, guild_id: undefined, member: undefined,
    user: { id: event.member.user.id } }, app);
  assert.equal(direct.kind, 'direct');
  assert.equal(direct.content, '/model provider/model');
  assert.equal(normalizeDiscordInteraction({ ...event, application_id: 'other' }, app), null);
  assert.equal(normalizeDiscordInteraction({ ...event, guild_id: 'other' }, app), null);
  assert.equal(discordCommandText({ type: 1, name: 'approve' }), null);
  assert.equal(discordCommandText({ ...event.data, options: [{ name: 'input', type: 3, value: 'x\n/approve' }] }), null);
});

test('command registration never overwrites unrelated commands including collisions', async () => {
  const calls = [];
  const existing = [{ type: 1, id: '1', name: 'help', description: 'another integration' },
    { ...DISCORD_APPLICATION_COMMANDS[1], id: '2' },
    { type: 1, id: '3', name: 'model', description: 'DSH · old' },
    { type: 1, id: '4', name: 'unrelated', description: 'leave me' }];
  const result = await syncDiscordCommands({
    listApplicationCommands: async args => args.guildId === DISCORD_COMMAND_GUILD ? existing : [],
    createApplicationCommand: async args => calls.push(['create', args]),
    editApplicationCommand: async args => calls.push(['edit', args]),
  }, app);
  assert.deepEqual(result.collisions, ['help']);
  assert.deepEqual(result.updated, ['model']);
  const guildCalls = calls.filter(([, args]) => args.guildId === DISCORD_COMMAND_GUILD);
  assert.ok(guildCalls.length > 0);
  assert.ok(guildCalls.every(([, args]) => !['help', 'models', 'unrelated'].includes(args.command.name)));
});

test('command registration adds bot-DM-only global commands alongside the guild commands', async () => {
  const reads = [];
  const writes = [];
  const result = await syncDiscordCommands({
    listApplicationCommands: async args => { reads.push(args); return []; },
    createApplicationCommand: async args => writes.push(args),
    editApplicationCommand: async () => assert.fail('empty command directories must not edit'),
  }, app);
  assert.deepEqual(new Set(reads.map(args => args.guildId ?? 'global')), new Set([DISCORD_COMMAND_GUILD, 'global']));
  const globalWrites = writes.filter(args => args.guildId === undefined);
  const guildWrites = writes.filter(args => args.guildId === DISCORD_COMMAND_GUILD);
  assert.equal(globalWrites.length, DISCORD_APPLICATION_COMMANDS.length);
  assert.equal(guildWrites.length, DISCORD_APPLICATION_COMMANDS.length);
  assert.ok(globalWrites.every(args => args.command.contexts?.length === 1 && args.command.contexts[0] === 1));
  assert.ok(globalWrites.every(args => JSON.stringify(args.command.integration_types) === '[0]'));
  assert.equal(result.global.created.length, DISCORD_APPLICATION_COMMANDS.length);
  assert.equal(result.guild.created.length, DISCORD_APPLICATION_COMMANDS.length);
});

test('command readbacks with default required=false omitted do not trigger repeat updates', async () => {
  const withoutRequired = options => options?.map(({ required, ...option }) => option);
  const guild = DISCORD_APPLICATION_COMMANDS.map((command, index) => ({
    ...command, id: `guild-${index}`, options: withoutRequired(command.options),
  }));
  const global = DISCORD_APPLICATION_COMMANDS.map((command, index) => ({
    ...command, id: `global-${index}`, options: withoutRequired(command.options), contexts: [1], integration_types: [0],
  }));
  const writes = [];
  const result = await syncDiscordCommands({
    listApplicationCommands: async args => args.guildId === DISCORD_COMMAND_GUILD ? guild : global,
    createApplicationCommand: async args => writes.push(args),
    editApplicationCommand: async args => writes.push(args),
  }, app);
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.collisions, []);
  assert.deepEqual(writes, []);
});

test('goal registration moves the free objective first for both guild and bot DM commands', async () => {
  const writes = [];
  const commands = direct => DISCORD_APPLICATION_COMMANDS.map((command, index) => {
    const id = `${direct ? 'global' : 'guild'}-${index}`;
    let options = command.options;
    if (command.name === 'goal') {
      const [objective, action, rounds] = options;
      options = [action, objective, rounds];
    }
    return { ...command, id, options, ...(direct ? { contexts: [1], integration_types: [0] } : {}) };
  });
  const result = await syncDiscordCommands({
    listApplicationCommands: async ({ guildId }) => commands(guildId === undefined),
    createApplicationCommand: async () => assert.fail('existing commands must be updated in place'),
    editApplicationCommand: async update => writes.push(update),
  }, app);
  assert.deepEqual(result.guild.updated, ['goal']);
  assert.deepEqual(result.global.updated, ['goal']);
  assert.equal(writes.length, 2);
  for (const { command } of writes) {
    assert.deepEqual(command.options.map(option => option.name), ['objective', 'action', 'rounds']);
    assert.ok(command.options.every(option => option.required === false));
    assert.equal(command.options[0].type, 3);
    assert.equal(command.options[0].choices, undefined);
    assert.deepEqual(command.options[1].choices.map(choice => choice.value), ['status', 'create', 'pause', 'resume']);
  }
});

test('goal objective alone creates and legacy action and short controls remain unambiguous', () => {
  const native = (...options) => discordCommandText({ type: 1, name: 'goal', options });
  const objective = value => ({ name: 'objective', type: 3, value });
  const action = value => ({ name: 'action', type: 3, value });
  const rounds = value => ({ name: 'rounds', type: 4, value });
  assert.equal(native(), '/goal');
  assert.equal(native(objective(' 写完周报 ')), '/goal create --rounds 256 写完周报');
  assert.equal(native(rounds(12), objective('create a report')), '/goal create --rounds 12 create a report');
  assert.equal(native(action('create'), objective('写完周报')), '/goal create --rounds 256 写完周报');
  assert.equal(native(action('create')), '/goal create');
  assert.equal(native(objective('create')), '/goal create');
  for (const shortcut of ['status', 'pause', 'resume']) {
    assert.equal(native(objective(shortcut)), `/goal ${shortcut}`);
    assert.equal(native(action(shortcut)), `/goal ${shortcut}`);
    assert.equal(native(action('create'), objective(shortcut)), `/goal create --rounds 256 ${shortcut}`);
  }
  assert.equal(native(objective('status'), rounds(12)), '/goal create --rounds 12 status');
  for (const invalid of [
    [action('pause'), objective('write a report')], [action('status'), rounds(12)], [rounds(12)],
    [objective(' first '), objective('second')], [objective(' \n')], [objective('a\n/goal pause')],
    [objective('x'.repeat(1001))], [objective('ok'), rounds(257)], [null],
  ]) assert.equal(native(...invalid), null);
});

test('goal form submission becomes the typed create command; bad input falls back to the hint', () => {
  const submit = (objective, rounds) => normalizeDiscordInteraction({ ...event, type: 5, data: { custom_id: 'dgoal1', components: [
    { type: 1, components: [{ type: 4, custom_id: 'objective', value: objective }] },
    { type: 18, component: { type: 4, custom_id: 'rounds', value: rounds } },
  ] } }, app);
  assert.equal(submit(' 把星露谷玩到秋天 ', '').content, '/goal create --rounds 256 把星露谷玩到秋天');
  assert.equal(submit('写完周报', '12').content, '/goal create --rounds 12 写完周报');
  for (const [objective, rounds] of [['', ''], ['--x', ''], ['ok', '0'], ['ok', '999'], ['ok', '1.5']]) {
    assert.equal(submit(objective, rounds).content, '/goal create');
  }
  assert.equal(normalizeDiscordInteraction({ ...event, type: 5, data: { custom_id: 'other', components: [] } }, app), null);
  assert.equal(discordGoalModal().custom_id, 'dgoal1');
});

test('an option-less /goal create opens the form as the first response', async () => {
  const calls = []; const listeners = new Map();
  const socket = { readyState: 1, addEventListener: (name, fn) => listeners.set(name, fn),
    send: raw => { if (JSON.parse(raw).op === 2) queueMicrotask(() => listeners.get('message')({ data: JSON.stringify({ op: 0, t: 'READY', d: { session_id: 's' } }) })); }, close() {} };
  const runtime = new DiscordRuntime({ config: { platformId: app, botId: 'test' }, token: 'test',
    harness: { ensureRunning: async () => true },
    state: { hasSeen: () => false, markSeen: async () => {}, sessionFor: () => undefined },
    createApi: () => ({ getCurrentUser: async () => ({ id: app, bot: true }), getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
      respondInteraction: async args => calls.push(args),
      createMessage: async () => assert.fail('the form must not post a message') }),
    createWebSocket: () => { queueMicrotask(() => listeners.get('message')({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) })); return socket; },
  });
  try {
    await runtime.start();
    listeners.get('message')({ data: JSON.stringify({ op: 0, t: 'INTERACTION_CREATE', d: { ...event,
      data: { name: 'goal', type: 1, options: [{ name: 'action', type: 3, value: 'create' }] } } }) });
    for (let i = 0; i < 100 && !calls.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 9);
    assert.equal(calls[0].data.custom_id, 'dgoal1');
  } finally { await runtime.stop(); }
});

test('Gateway objective-only /goal creates immediately through the Host and persists its output route', { timeout: 5_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-inline-goal-'));
  let runtime;
  let connection;
  t.after(async () => {
    await runtime?.stop();
    connection?.apiProxy.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const sessionId = 'bound-session';
  const key = `group:${event.channel_id}`;
  const actor = event.member.user.id;
  const workspaces = await new BotWorkspaceStore(join(dir, 'workspaces.json'), { defaultWorkspace: dir }).load();
  await workspaces.ensure('test');
  const statePath = join(dir, 'state.json');
  const state = await new DiscordStateStore(statePath).load();
  await state.setSession(key, sessionId);
  const policy = directAccessPolicy({ users: [{ id: actor, canExecuteCommands: true }] });
  policy.getSettings().group = policy.getSettings().direct;

  const records = [], rpc = [], acknowledgements = [];
  let goal = null;
  const ctx = {
    get: service => service === 'agents' ? { get: id => ({ session: { id, snapshotEvents: () => records } }) } : undefined,
    typertGateway: {
      async invoke(call) {
        assert.equal(call.namespace, 'goals');
        assert.equal(call.args.agentId, sessionId);
        rpc.push(call);
        if (call.method === 'get') return goal;
        assert.equal(call.method, 'create');
        goal = { ...call.args.request, id: 'inline-goal', revision: 1, phase: 'active', activation: 'armed', roundsStarted: 0 };
        records.push({ type: 'goal/change', seq: 41, data: { operation: 'create', goal } });
        return { ref: { id: goal.id, revision: goal.revision } };
      },
      stream() { assert.fail('the local Fast Command needs no stream'); },
    },
  };
  connection = harnessConnection(ctx);
  const harness = new DiscordHarnessClient({
    ...connection, workspace: dir, autostart: false, commandExecutor: createHarnessCommandExecutor(ctx),
  });
  const { promise: confirmed, resolve: confirm } = Promise.withResolvers();
  const listeners = new Map();
  const receive = packet => listeners.get('message')({ data: JSON.stringify(packet) });
  const socket = {
    readyState: 1,
    addEventListener: (name, fn) => listeners.set(name, fn),
    send(raw) {
      if (JSON.parse(raw).op === 2) queueMicrotask(() => receive({ op: 0, t: 'READY', d: { session_id: 's' } }));
    },
    close() {},
  };
  runtime = new DiscordRuntime({
    config: { platformId: app, botId: 'test' }, token: 'test', accessPolicy: policy,
    ...createBotWorkspaceScope(harness, { botId: 'test', workspaces, state }),
    createApi: () => ({
      getCurrentUser: async () => ({ id: app, bot: true }),
      getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
      respondInteraction: async args => {
        acknowledgements.push(args);
        if (args.type === 9) confirm({ kind: 'modal' });
      },
      editOriginalInteraction: async args => { confirm({ kind: 'interaction-edit', ...args }); return { id: 'confirmation' }; },
      createMessage: async args => { confirm({ kind: 'message', ...args }); return { id: 'confirmation' }; },
    }),
    createWebSocket: () => {
      queueMicrotask(() => receive({ op: 10, d: { heartbeat_interval: 45_000 } }));
      return socket;
    },
  });
  await runtime.start();
  const objective = '完成当前报告';
  receive({ op: 0, t: 'INTERACTION_CREATE', d: { ...event,
    data: { name: 'goal', type: 1, options: [{ name: 'objective', type: 3, value: objective }] },
  } });
  const confirmation = await confirmed;
  assert.deepEqual(acknowledgements.map(ack => ack.type), [4]);
  assert.equal(acknowledgements[0].data.flags, 64);
  assert.equal(confirmation.kind, 'message');
  assert.equal(confirmation.channelId, event.channel_id);
  assert.equal(confirmation.components, undefined);
  assert.ok(confirmation.content.includes(objective));
  assert.deepEqual(rpc.map(call => call.method), ['get', 'create', 'get']);
  assert.deepEqual(rpc[1].args.request, { objective, maxGoalRounds: 256 });
  const restored = await new DiscordStateStore(statePath).load();
  const route = restored.goalOutputRouteFor(key);
  assert.equal(route.sessionId, sessionId);
  assert.equal(route.actor, actor);
  assert.equal(route.goalId, 'inline-goal');
  assert.equal(route.goalStartSeq, 41);
});

test('native multi select is bounded and has exact index identity', () => {
  const question = { id: 'x', question: 'Choose', multiSelect: true, options: [{ label: '2' }, { label: 'A' }] };
  const card = DISCORD_INTERACTION_CARD.render(question, { nonce: 'nonce', questionIndex: 2 });
  const select = card.markup.components[0].components[0];
  assert.equal(select.max_values, 2);
  assert.deepEqual(DISCORD_INTERACTION_CARD.parse(select.custom_id, { componentType: 3, values: ['0', '1'] }),
    { nonce: 'nonce', questionIndex: 2, optionIndexes: [0, 1] });
  for (const values of [[], ['0', '0'], ['1e0'], ['-1'], ['00']]) {
    assert.equal(DISCORD_INTERACTION_CARD.parse(select.custom_id, { componentType: 3, values }), null);
  }
  assert.deepEqual(discordCardComponents({ inline_keyboard: [] }), []);
});

test('Discord Skip is a distinct button callback and remains available with free text', () => {
  const nonce = 'nonce', questionIndex = 2;
  for (const options of [undefined, [{ label: 'A' }, { label: 'B' }]]) {
    const card = DISCORD_INTERACTION_CARD.render({ id: 'x', question: 'Choose', options }, { nonce, questionIndex });
    const components = card.markup.components.flatMap((row) => row.components);
    const skip = components.find((component) => component.type === 2);
    assert.equal(skip.custom_id, 'dq1|nonce|2|skip');
    assert.deepEqual(DISCORD_INTERACTION_CARD.parse(skip.custom_id, { componentType: 2 }),
      { action: 'skip', nonce, questionIndex });
    assert.equal(DISCORD_INTERACTION_CARD.parse(skip.custom_id, { componentType: 3, values: ['0'] }), null);
    assert.equal(DISCORD_INTERACTION_CARD.parse(skip.custom_id, { componentType: 2, values: ['0'] }), null);
    assert.equal(components.some((component) => component.type === 3), Boolean(options));
  }
});

test('Discord approval and plan intents cannot be skipped with a forged question action', () => {
  for (const intent of ['approval', 'plan']) {
    const question = { id: 'x', question: 'Confirm', intent, options: [{ label: 'Yes' }] };
    const card = DISCORD_INTERACTION_CARD.render(question, { nonce: 'nonce' });
    assert.deepEqual(card.markup.components.flatMap((row) => row.components).map((item) => item.type), [3]);
    const forged = DISCORD_INTERACTION_CARD.parse('dq1|nonce|0|skip', { componentType: 2 });
    assert.equal(DISCORD_INTERACTION_CARD.accepts(question, forged), false);
  }
});

test('Discord oversized labels and text preserve the full question and exact option index', () => {
  const longLabel = '长选项 ' + '字'.repeat(110);
  const detail = 'Synthetic detail ' + 'x'.repeat(2100);
  const question = { id: 'x', question: 'Choose', detail, options: [{ label: longLabel }, { label: 'Short' }] };
  const card = DISCORD_INTERACTION_CARD.render(question, { nonce: 'nonce' });
  assert.ok(card.prelude.includes(longLabel));
  assert.ok(card.prelude.includes(detail));
  assert.ok(card.text.length <= 2000);
  const components = card.markup.components.flatMap((row) => row.components);
  const menu = components.find((component) => component.type === 3);
  assert.ok(menu.options[0].label.length <= 100);
  assert.deepEqual(menu.options.map((option) => option.value), ['0', '1']);
  assert.ok(components.some((component) => component.type === 2));

  const tooMany = Array.from({ length: 26 }, (_, index) => ({ label: `Option ${index + 1}` }));
  const fallback = DISCORD_INTERACTION_CARD.render({ ...question, detail: undefined, options: tooMany }, { nonce: 'nonce' });
  assert.match(fallback.prelude ?? fallback.text, /26\. Option 26/u);
  assert.deepEqual(fallback.markup.components.flatMap((row) => row.components).map((component) => component.type), [2]);
});

test('Discord Skip does not add a control or callback to the Telegram adapter', () => {
  const question = { id: 'x', question: 'Choose', options: [{ label: 'A' }] };
  const telegram = TELEGRAM_INTERACTION_CARD.render(question, { nonce: 'nonce', questionIndex: 2 });
  assert.deepEqual(telegram.markup.inline_keyboard.flat().map((item) => item.text), ['A']);
  assert.deepEqual(TELEGRAM_INTERACTION_CARD.parse(telegram.markup.inline_keyboard[0][0].callback_data),
    { nonce: 'nonce', questionIndex: 2, optionIndex: 0 });
  assert.equal(TELEGRAM_INTERACTION_CARD.parse('dq1|nonce|2|skip'), null);
  assert.equal(TELEGRAM_INTERACTION_CARD.render({ ...question, options: [] }, { nonce: 'nonce' }), null);
});

test('approval adapter rejects another route and stranger without consuming real decision', async () => {
  const card = new DiscordApprovalCard();
  const entry = card.registry.issue({ conversationKey: 'group:channel', kind: 'approval', payload: { approvalId: 'host-id', actor: 'owner' } });
  const callback = { data: `ap1|${entry.nonce}|a`, kind: 'group', conversationId: 'wrong', senderId: 'owner' };
  let submits = 0;
  const options = { answer: async () => {}, submit: async () => { submits++; return 'submitted'; } };
  await card.handlePress(callback, options);
  await card.handlePress({ ...callback, conversationId: 'channel', senderId: 'stranger' }, options);
  assert.equal(submits, 0);
  await card.handlePress({ ...callback, conversationId: 'channel' }, options);
  assert.equal(submits, 1);
  await card.handlePress({ ...callback, conversationId: 'channel' }, options);
  assert.equal(submits, 1);
});

test('bridge submits exact multi labels once and rejects stranger, stale nonce and wrong message', async () => {
  const seen = new Set();
  let card, answer, release;
  const completion = new Promise(resolve => { release = resolve; });
  const bridge = new DiscordHarnessBridge({
    state: { sessionFor: () => 'session', hasSeen: id => seen.has(id), markSeen: async id => seen.add(id) },
    bot: { sendText: async () => {}, sendInteractionCard: async (_, value) => { card = value; return { providerMessageIds: ['card-id'] }; },
      updateInteractionCard: async () => {}, answerInteractionCallback: async () => {} },
    harness: { sessionExists: async () => true, ask: async (sessionId, text, options) => {
      await options.onInteraction({ kind: 'question', interactionId: 'q-id', rpcId: 'rpc', sessionId,
        payload: { questions: [{ id: 'q', question: 'pick', multiSelect: true, options: [{ label: '2' }, { label: 'A' }] }] },
        respond: async value => { answer = value; release(); return { accepted: true }; } });
      await completion;
      return 'done';
    } },
  });
  const pending = bridge.accept({ messageId: 'prompt', senderId: 'owner', kind: 'group', conversationId: 'channel',
    content: 'ask', addressed: true, replyTarget: { channelId: 'channel' } });
  for (let i = 0; i < 100 && !card; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(card);
  const callback = { messageId: 'press', senderId: 'owner', kind: 'group', conversationId: 'channel',
    data: card.markup.components[0].components[0].custom_id, componentType: 3, values: ['0', '1'], providerMessageId: 'card-id' };
  await bridge.acceptCallback({ ...callback, senderId: 'stranger' });
  await bridge.acceptCallback({ ...callback, data: 'dq1|stale|0' });
  await bridge.acceptCallback({ ...callback, providerMessageId: 'other-card' });
  assert.equal(answer, undefined);
  await bridge.acceptCallback(callback);
  await pending;
  assert.deepEqual(answer.value.answer.answers, [{ id: 'q', selected: ['2', 'A'] }]);
});

test('Gateway slash ACK precedes shared command delivery without message reactions', async () => {
  const calls = []; const listeners = new Map();
  const socket = { readyState: 1, addEventListener: (name, fn) => listeners.set(name, fn),
    send: raw => { if (JSON.parse(raw).op === 2) queueMicrotask(() => listeners.get('message')({ data: JSON.stringify({ op: 0, t: 'READY', d: { session_id: 's' } }) })); }, close() {} };
  const runtime = new DiscordRuntime({ config: { platformId: app, botId: 'test' }, token: 'test',
    harness: { ensureRunning: async () => true },
    state: { hasSeen: () => false, markSeen: async () => {} },
    createApi: () => ({ getCurrentUser: async () => ({ id: app, bot: true }), getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
      respondInteraction: async args => calls.push(['ack', args]),
      createMessage: async args => { calls.push(['message', args]); return { id: '555555555555555555' }; },
      addOwnReaction: async () => assert.fail('slash must not react to interaction ID') }),
    createWebSocket: () => { queueMicrotask(() => listeners.get('message')({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) })); return socket; },
  });
  try {
    await runtime.start();
    listeners.get('message')({ data: JSON.stringify({ op: 0, t: 'INTERACTION_CREATE', d: { ...event, data: { name: 'reasoninglist', type: 1 } } }) });
    for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls[0][0], 'ack');
    assert.equal(calls[0][1].type, 4);
    assert.equal(calls[1][0], 'message');
    assert.equal(calls[1][1].replyToMessageId, undefined);
  } finally { await runtime.stop(); }
});

test('application command creation honors a definite 429 rejection once', async () => {
  let attempts = 0;
  const keep = setInterval(() => {}, 1000);
  try {
    const api = new DiscordApi({ token: `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(28)}`,
      fetchImpl: async () => ++attempts === 1
        ? Response.json({ retry_after: 0.001 }, { status: 429 })
        : Response.json({ id: '555555555555555555' }) });
    await api.createApplicationCommand({ applicationId: app, guildId: DISCORD_COMMAND_GUILD, command: DISCORD_APPLICATION_COMMANDS[0] });
    assert.equal(attempts, 2);
  } finally { clearInterval(keep); }
});

test('application command API supports the global endpoint used by bot DMs', async () => {
  const paths = [];
  const api = new DiscordApi({ token: `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(28)}`,
    fetchImpl: async (url, options) => {
      paths.push({ path: url.pathname, method: options.method });
      return Response.json(options.method === 'GET' ? [] : { id: '555555555555555555' });
    } });
  const command = DISCORD_APPLICATION_COMMANDS[0];
  await api.listApplicationCommands({ applicationId: app });
  await api.createApplicationCommand({ applicationId: app, command });
  await api.editApplicationCommand({ applicationId: app, commandId: '555555555555555555', command });
  assert.deepEqual(paths, [
    { path: `/api/v10/applications/${app}/commands`, method: 'GET' },
    { path: `/api/v10/applications/${app}/commands`, method: 'POST' },
    { path: `/api/v10/applications/${app}/commands/555555555555555555`, method: 'PATCH' },
  ]);
});

test('API callback uses bounded HTTP acknowledgment; card edits clear components', async () => {
  const calls = [];
  const api = new DiscordApi({ token: `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(28)}`, fetchImpl: async (url, options) => {
    calls.push({ url, options, body: options.body && JSON.parse(options.body) });
    return options.method === 'POST' && url.pathname.endsWith('/callback')
      ? new Response(null, { status: 204 }) : Response.json({ id: '555555555555555555' });
  } });
  await api.respondInteraction({ interactionId: event.id, token: event.token, type: 6 });
  assert.match(calls[0].url.pathname, /\/callback$/);
  assert.deepEqual(calls[0].body, { type: 6 });
  const bot = new DiscordBotClient({ api });
  await bot.sendInteractionCard({ channelId: event.channel_id }, { text: 'approval', markup: { inline_keyboard: [[{ text: 'approve', callback_data: 'ap1|abc|a' }]] } });
  assert.equal(calls[1].body.components[0].components[0].type, 2);
  assert.deepEqual(calls[1].body.allowed_mentions.parse, []);
  await bot.updateInteractionCard({ channelId: event.channel_id }, '555555555555555555', { markup: { inline_keyboard: [] } });
  assert.deepEqual(calls[2].body.components, []);
});
