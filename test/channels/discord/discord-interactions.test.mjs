import assert from 'node:assert/strict';
import test from 'node:test';
import { DISCORD_COMMAND_GUILD, DISCORD_APPLICATION_COMMANDS, syncDiscordCommands,
  discordCommandText, normalizeDiscordInteraction, DISCORD_INTERACTION_CARD,
  DiscordApprovalCard, discordCardComponents } from '../../../src/channels/discord/discord-interactions.mjs';
import { DiscordHarnessBridge } from '../../../src/channels/discord/discord-bridge.mjs';
import { DiscordApi } from '../../../src/channels/discord/discord-api.mjs';
import { DiscordBotClient, DiscordRuntime } from '../../../src/channels/discord/discord-runtime.mjs';

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
    listApplicationCommands: async () => existing,
    createApplicationCommand: async args => calls.push(['create', args]),
    editApplicationCommand: async args => calls.push(['edit', args]),
  }, app);
  assert.deepEqual(result.collisions, ['help']);
  assert.deepEqual(result.updated, ['model']);
  assert.ok(calls.every(([, args]) => args.guildId === DISCORD_COMMAND_GUILD));
  assert.ok(calls.every(([, args]) => !['help', 'models', 'unrelated'].includes(args.command.name)));
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
  assert.equal(DISCORD_INTERACTION_CARD.render({ ...question, options: Array(26).fill({ label: 'a' }) }, { nonce: 'n' }), null);
  assert.deepEqual(discordCardComponents({ inline_keyboard: [] }), []);
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
