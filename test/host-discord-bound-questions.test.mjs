import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { DeliveryService } from '../plugin-src/host/delivery-service.mjs';
import { createImHostPlugin } from '../plugin-src/host/index.mjs';
import { modernHarnessApi } from '../plugin-src/host/modern-harness-api.mjs';
import { DiscordController } from '../src/channels/discord/discord-controller.mjs';
import { DISCORD_COMMAND_GUILD } from '../src/channels/discord/discord-interactions.mjs';
import { DiscordRuntime } from '../src/channels/discord/discord-runtime.mjs';
import { DiscordHarnessClient } from '../src/channels/discord/harness-client.mjs';
import { DiscordStateStore } from '../src/channels/discord/state-store.mjs';
import { BotWorkspaceStore, createBotWorkspaceScope } from '../src/channels/shared/bot-workspace-store.mjs';
import { getDeliverySyncSettingsStore } from '../src/channels/shared/delivery-sync-settings-store.mjs';
import { t as translate } from '../src/channels/shared/i18n.mjs';
import { directAccessPolicy } from './channels/access-policy-fixture.mjs';

const botId = 'discord_test';
const platformId = '123456789012345670';
const actor = '222222222222222221';
const otherActor = '222222222222222222';
const channelId = '333333333333333331';
const otherChannelId = '333333333333333332';
const sessionId = 'question-session';
const key = `group:${channelId}`;
const targetId = 'question-target';
const token = 'a'.repeat(24) + '.aaaa.' + 'b'.repeat(24);
const questions = [{ id: 'choice', question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }];
const yes = { answers: [{ id: 'choice', selected: ['Yes'] }] };
const no = { answers: [{ id: 'choice', selected: ['No'] }] };
const noProvider = () => Promise.reject(Object.assign(new Error('no native provider'), { code: 'NO_PROVIDER' }));

async function until(predicate, message) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(setImmediate);
  }
}

async function* frames(value) { yield value; }

class FakeGateway extends EventTarget {
  readyState = 1;
  #sequence = 0;

  receive(packet) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) })); }

  dispatch(type, data) { this.receive({ op: 0, t: type, s: ++this.#sequence, d: data }); }

  send(raw) {
    if (JSON.parse(raw).op === 2) {
      queueMicrotask(() => this.dispatch('READY', {
        session_id: 'discord-gateway-session', resume_gateway_url: 'wss://gateway.discord.gg',
      }));
    }
  }

  close() { this.readyState = 3; }
}

async function fixture(t, { thread = false, questionFromPrompt = false, cardGate } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-discord-bound-question-'));
  const workspaces = await new BotWorkspaceStore(join(dir, 'workspaces.json'), { defaultWorkspace: dir }).load();
  await workspaces.ensure(botId);
  await workspaces.setBusyMessageMode(botId, 'steer');
  const state = await new DiscordStateStore(join(dir, 'state.json')).load();
  await state.setSession(key, sessionId);
  await state.rememberAuthor(key, { senderId: actor, isBot: false });

  const listeners = new Map();
  const events = [];
  const prompts = [], cards = [], textMessages = [], attempts = [], edits = [], acknowledgements = [], followups = [];
  const turnAnswers = [];
  const activeTurns = [];
  const turnSignal = new AbortController();
  const session = { id: sessionId, snapshotEvents: () => events };
  const requestQuestion = ({ id = sessionId, signal, origin = 'goal', native = noProvider }) => {
    const snapshotEvents = () => origin === 'live' ? events : [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      ...(origin === 'desktop' ? [{ type: 'user/message', seq: 1,
        data: { turn: 1, source: { kind: 'user', rpcId: 'desktop-prompt' } } }] : []),
    ];
    const request = { agent: { session: { id, snapshotEvents } }, questions, signal };
    const result = listeners.get('user-questions/request')(request, native);
    void result.catch(() => {});
    return { request, result };
  };
  const append = (type, data) => {
    const event = { type, data, seq: events.length, time: events.length };
    events.push(event);
    listeners.get('session/event')(session, event);
  };
  const ctx = {
    root: {},
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    typertGateway: {
      stream({ namespace, method }) {
        if (namespace === 'workspace' && method === 'follow') {
          return frames({ type: 'baseline', value: { items: [], archivedSessionIds: [] } });
        }
        assert.equal(`${namespace}/${method}`, 'session/follow');
        return frames({ type: 'snapshot', cursor: events.length - 1, records: events.map(event => ({ type: 'event', event })) });
      },
      async invoke({ namespace, method, args }) {
        if (namespace === 'session' && method === 'page') {
          return { records: events.map(event => ({ type: 'event', event })), hasMore: false };
        }
        assert.equal(`${namespace}/${method}`, 'session/prompt');
        const prompt = args.request;
        prompts.push(prompt);
        const turn = prompts.length;
        const running = (async () => {
          append('turn/start', { turn });
          append('user/message', { turn, source: { kind: 'user', rpcId: prompt.requestId } });
          if (questionFromPrompt) {
            const { result } = requestQuestion({ origin: 'live', signal: turnSignal.signal });
            turnAnswers.push(await result);
          }
          append('assistant/message', { turn, message: { content: [{ type: 'text', text: 'turn finished' }] } });
          append('turn/end', { turn, reason: { kind: 'completed' } });
        })();
        activeTurns.push(running);
        void running.catch(() => {});
        return { accepted: true };
      },
    },
  };
  const service = new DeliveryService();
  const hostConfig = { dshHome: dir };
  const syncSettings = getDeliverySyncSettingsStore(hostConfig);
  const startNames = [
    'Feishu', 'Weixin', 'Dingtalk', 'Wecom', 'WecomApp', 'Qq', 'Slack', 'Telegram',
    'Discord', 'Whatsapp', 'IMessage', 'Email', 'Matrix', 'Office',
  ];
  await createImHostPlugin({
    ...Object.fromEntries(startNames.map(name => [`apply${name}`, () => {}])),
    installHostLanguage: () => {},
    installInjectedContext: () => {},
    createDeliveryService: () => service,
  }).apply({}, hostConfig);
  const presentSyncedQuestion = t.mock.method(service, 'presentSessionSyncQuestion');
  const modern = modernHarnessApi(ctx, { deliveryService: service });
  const client = new DiscordHarnessClient({ apiProxy: modern, interactionScope: ctx.root, workspace: dir, autostart: false });
  const scope = createBotWorkspaceScope(client, { botId, workspaces, state });
  const policy = directAccessPolicy({ users: [actor, otherActor].map(id => ({ id, canExecuteCommands: true })) });
  policy.getSettings().group = policy.getSettings().direct;
  const socket = new FakeGateway();
  const logger = { warn() {}, error() {}, info() {} };
  let messageSequence = 0;
  const nextId = () => `44444444444${String(++messageSequence).padStart(6, '0')}`;
  const config = { botId, platformId, tokenRef: 'fake-token', name: 'Question bot', liveText: false, thinkingTraces: false };
  const runtime = new DiscordRuntime({
    config, token, ...scope, accessPolicy: policy, logger,
    createApi: () => ({
      getCurrentUser: async () => ({ id: platformId, bot: true }),
      getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
      getChannel: async ({ channelId: id }) => ({ id, type: id === channelId && thread ? 11 : 0, owner_id: platformId }),
      sendTyping: async () => {},
      addOwnReaction: async () => {},
      removeOwnReaction: async () => {},
      async createMessage(message) {
        const id = nextId();
        if (message.components?.length) {
          attempts.push(message);
          await cardGate?.promise;
          cards.push({ ...message, id });
        } else textMessages.push(message);
        return { id };
      },
      async editMessage(message) { edits.push(message); return { id: message.messageId }; },
      async respondInteraction(message) { acknowledgements.push(message); },
      async followupInteraction(message) { followups.push(message); },
    }),
    createWebSocket: () => {
      queueMicrotask(() => socket.receive({ op: 10, d: { heartbeat_interval: 45_000 } }));
      return socket;
    },
  });
  const controller = new DiscordController({
    configStore: {
      list: () => [config], get: (id) => id === botId ? config : null,
      save: async () => assert.fail('test should not change the saved bot'),
      remove: async () => assert.fail('test should not remove the bot'),
    },
    credentials: {
      resolve: async () => ({ value: token }),
      set: async () => assert.fail('test should not write credentials'),
      unset: async () => assert.fail('test should not remove credentials'),
    },
    inspectOwner: async () => null, createRuntime: async () => runtime, logger,
  });
  service.registerAdapter(createDeliveryAdapter({ channel: 'discord', workspaces, stateFor: async () => state, coreController: controller }));
  t.after(async () => {
    cardGate?.resolve();
    turnSignal.abort();
    modern.dispose();
    await controller.close();
    await Promise.allSettled(activeTurns);
    await rm(dir, { recursive: true, force: true });
  });
  await controller.initialize();
  assert.equal(runtime.status.ready, true);
  await service.createTarget(botId, { targetId, name: 'Bound Discord', kind: 'channel', route: { channelId } });
  const sync = (enabled) => service.setSessionSync(botId, targetId, enabled);
  await sync(true);
  return {
    state, runtime, prompts, cards, textMessages, attempts, edits, turnAnswers, sync, requestQuestion, presentSyncedQuestion,
    service, syncSettings, dir,
    text(content, user = actor) {
      const id = nextId();
      socket.dispatch('MESSAGE_CREATE', { id, channel_id: channelId, guild_id: DISCORD_COMMAND_GUILD,
        author: { id: user, bot: false }, content });
      return id;
    },
    async choose(card, { user = actor, route = channelId } = {}) {
      const id = nextId();
      const nonce = `click-${id}`;
      const { custom_id } = card.components[0].components[0];
      socket.dispatch('INTERACTION_CREATE', { id, token: nonce, application_id: platformId, channel_id: route,
        guild_id: DISCORD_COMMAND_GUILD, type: 3, member: { user: { id: user } },
        message: { id: card.id, author: { id: platformId } },
        data: { custom_id, component_type: 3, values: ['0'] } });
      await until(() => followups.some(reply => reply.token === nonce), 'card press did not finish');
      assert.equal(acknowledgements.find(ack => ack.token === nonce)?.type, 6);
    },
  };
}

test('Discord-origin question still reaches the ordinary turn watcher exactly once', async (t) => {
  const f = await fixture(t, { questionFromPrompt: true });
  f.text('Ask me whether to continue');
  await until(() => f.cards.length > 0, 'ordinary watcher omitted the Discord card');
  assert.equal(f.cards[0].channelId, channelId);
  await f.choose(f.cards[0]);
  await until(() => f.runtime.status.messagesReplied === 1, 'originating turn did not complete');
  assert.deepEqual(f.turnAnswers, [yes]);
  assert.equal(f.cards.length, 1);
  assert.deepEqual(f.prompts.map(prompt => prompt.mode), ['queue']);
  assert.equal(f.presentSyncedQuestion.mock.callCount(), 0);
});

test('global text switches stay off while the exact Discord group can receive questions', async (t) => {
  const f = await fixture(t);
  const privateKey = `direct:${otherChannelId}`;
  const privateSession = 'discord-private';
  await f.state.setSession(privateKey, privateSession);
  await f.service.createTarget(botId, {
    targetId: 'discord-private', name: 'Discord private', kind: 'channel', route: { channelId: otherChannelId },
  });
  await f.service.setSessionSync(botId, 'discord-private', true);

  const feishuBot = 'feishu_test';
  const feishuKey = 'p2p:ou_author';
  const feishuSession = 'feishu-private';
  const feishuWorkspaces = await new BotWorkspaceStore(join(f.dir, 'feishu-workspaces.json'), {
    defaultWorkspace: f.dir,
  }).load();
  await feishuWorkspaces.ensure(feishuBot);
  const feishuState = await new DiscordStateStore(join(f.dir, 'feishu-state.json')).load();
  await feishuState.setSession(feishuKey, feishuSession);
  f.service.registerAdapter(createDeliveryAdapter({
    channel: 'feishu', workspaces: feishuWorkspaces, stateFor: async () => feishuState, coreController: {},
  }));
  await f.service.createTarget(feishuBot, {
    targetId: 'feishu-private', name: 'Feishu private', kind: 'user', route: { openId: 'ou_author' },
  });
  await f.service.setSessionSync(feishuBot, 'feishu-private', true);

  const groupTarget = { channel: 'discord', botId, targetId };
  assert.deepEqual(await f.service.listSessionSyncTargets(sessionId), []);
  assert.deepEqual(await f.service.listSessionSyncTargets(sessionId, { question: true }), [groupTarget]);
  assert.deepEqual(await f.service.listSessionSyncTargets(privateSession, { question: true }), []);
  assert.deepEqual(await f.service.listSessionSyncTargets(feishuSession, { question: true }), []);
  assert.deepEqual(await f.service.listSessionSyncTargets('foreign-session', { question: true }), []);
  assert.deepEqual(await f.syncSettings.get(), {
    mirrorUserInput: false, deliverModelAnswers: false, inputIcon: '', modelIcon: '',
  });

  await f.syncSettings.set({ deliverModelAnswers: true });
  assert.deepEqual(await f.service.listSessionSyncTargets(sessionId, { question: true }), [groupTarget]);
  assert.deepEqual(await f.service.listSessionSyncTargets(privateSession), [
    { channel: 'discord', botId, targetId: 'discord-private' },
  ]);
  assert.deepEqual(await f.service.listSessionSyncTargets(feishuSession, { question: true }), [
    { channel: 'feishu', botId: feishuBot, targetId: 'feishu-private' },
  ]);
});

test('desktop question in a synced Discord group rejects the wrong actor and channel, then accepts its menu', async (t) => {
  const f = await fixture(t);
  const turn = new AbortController();
  const q = f.requestQuestion({ origin: 'desktop', signal: turn.signal });
  await until(() => f.cards.length === 1, 'synced group never received a card');
  const [card] = f.cards;
  assert.equal(card.channelId, channelId);
  assert.ok(card.content.includes(questions[0].question));
  await f.choose(card, { user: otherActor });
  await f.choose(card, { route: otherChannelId });
  assert.equal(f.edits.length, 0, 'unrelated presses cannot retire the real question');
  assert.equal(q.request.signal.aborted, false);
  await f.choose(card);
  assert.deepEqual(await q.result, yes);
  assert.equal(turn.signal.aborted, false, 'answering does not abort the enclosing turn');
  assert.equal(q.request.signal.aborted, true);
  assert.deepEqual(f.prompts, []);
  assert.ok(f.edits.some(edit => edit.messageId === card.id && edit.components.length === 0));
});

test('goal question uses the opted-in Discord thread and accepts a typed answer without steering', async (t) => {
  const f = await fixture(t, { thread: true });
  const q = f.requestQuestion({ origin: 'goal' });
  await until(() => f.cards.length === 1, 'synced thread never received a card');
  assert.equal(f.cards[0].channelId, channelId);
  f.text('A normal message from a different group member', otherActor);
  await until(() => f.runtime.status.messagesReplied === 1, 'normal message did not finish its own queued turn');
  assert.equal(q.request.signal.aborted, false);
  f.text('1');
  assert.deepEqual(await q.result, yes);
  assert.deepEqual(f.prompts.map(prompt => prompt.mode), ['queue']);
  assert.equal(f.textMessages.some(message => message.content.includes(translate('已提交补充指令，Agent 会在下一步读取。'))), false);
  assert.equal(f.cards.length, 1);
});

test('Discord refuses questions without a current opted-in binding to their exact Session', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.requestQuestion({ id: 'different-session' }).result, { code: 'NO_PROVIDER' });
  await f.sync(false);
  await assert.rejects(f.requestQuestion({}).result, { code: 'NO_PROVIDER' });
  await f.sync(true);
  await f.state.clearSession(key);
  await assert.rejects(f.requestQuestion({}).result, { code: 'NO_PROVIDER' });
  assert.deepEqual(f.attempts, []);
});

test('rebinding a Discord conversation invalidates an already displayed menu', async (t) => {
  const f = await fixture(t);
  const native = Promise.withResolvers();
  const q = f.requestQuestion({ native: () => native.promise });
  await until(() => f.cards.length === 1, 'question was not displayed before rebinding');
  const [oldCard] = f.cards;
  await f.state.setSession(key, 'replacement-session');
  await f.state.setSession(key, sessionId);
  await f.choose(oldCard);
  await until(() => f.edits.some(edit => edit.messageId === oldCard.id), 'stale card was not retired');
  native.resolve(no);
  assert.deepEqual(await q.result, no, 'the stale Discord reply cannot replace the native answer');
});

for (const winner of ['native completion', 'turn cancellation']) {
  test(`${winner} during Discord send retires the late card and releases the route`, async (t) => {
    const gate = Promise.withResolvers();
    const f = await fixture(t, { cardGate: gate });
    const turn = new AbortController();
    const native = Promise.withResolvers();
    const q = f.requestQuestion({ native: () => native.promise, signal: turn.signal });
    await until(() => f.attempts.length === 1, 'card delivery did not reach the in-flight boundary');
    if (winner === 'native completion') {
      native.resolve(no);
      assert.deepEqual(await q.result, no);
    } else {
      turn.abort();
      await assert.rejects(q.result, { code: 'ASK_ABORTED' });
    }
    gate.resolve();
    await until(() => f.edits.length === 1, 'late delivered card was not retired');
    await f.choose(f.cards[0]);
    const next = f.requestQuestion({});
    await until(() => f.cards.length === 2, 'retired question still occupies its Discord route');
    await f.choose(f.cards[1]);
    assert.deepEqual(await next.result, yes);
    assert.deepEqual(f.prompts, []);
  });
}
