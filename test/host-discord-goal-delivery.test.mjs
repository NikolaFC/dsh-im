import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { DeliveryService } from '../plugin-src/host/delivery-service.mjs';
import { createSessionSyncCoordinator } from '../plugin-src/host/session-sync-coordinator.mjs';
import { DiscordApi } from '../src/channels/discord/discord-api.mjs';
import { DiscordController } from '../src/channels/discord/discord-controller.mjs';
import { DiscordRuntime } from '../src/channels/discord/discord-runtime.mjs';
import { DiscordStateStore } from '../src/channels/discord/state-store.mjs';
import { BotWorkspaceStore, createBotWorkspaceScope } from '../src/channels/shared/bot-workspace-store.mjs';
import { directAccessPolicy } from './channels/access-policy-fixture.mjs';

const botId = 'discord_test';
const platformId = '123456789012345670';
const actor = '222222222222222221';
const replacementActor = '222222222222222222';
const channelId = '333333333333333331';
const researchId = '333333333333333332';
const key = `group:${channelId}`;
const researchKey = `direct:${researchId}`;
const sessionId = 'session-goal';
const token = 'a'.repeat(24) + '.aaaa.' + 'b'.repeat(24);
const authority = { goalId: 'goal-one', revision: 1, actor, sessionId, goalStartSeq: 4, deliverySeqFloor: 10 };

class FakeGateway extends EventTarget {
  readyState = 1;

  receive(packet) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) })); }

  send(raw) {
    if (JSON.parse(raw).op === 2) {
      queueMicrotask(() => this.receive({ op: 0, t: 'READY', s: 1, d: {
        session_id: 'discord-test-gateway', resume_gateway_url: 'wss://gateway.discord.gg',
      } }));
    }
  }

  close() { this.readyState = 3; }
}

async function fixture(t, { thread = false, remote = false, saveAuthority = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-discord-goal-output-'));
  let controller;
  t.after(async () => {
    await controller?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const statePath = join(dir, 'state.json');
  const state = await new DiscordStateStore(statePath).load();
  const workspaces = await new BotWorkspaceStore(join(dir, 'workspaces.json'), { defaultWorkspace: dir }).load();
  await workspaces.ensure(botId);
  await state.setSession(key, sessionId);
  await state.rememberAuthor(key, { senderId: actor, isBot: false });
  const remember = (routeKey = key, value = authority) => state.rememberGoalOutputRoute(
    routeKey, value, state.controlBindingVersion(routeKey),
  );
  if (saveAuthority) assert.equal(await remember(), true);
  const policy = directAccessPolicy({ users: [actor, replacementActor].map(id => ({ id, canExecuteCommands: true })) });
  policy.getSettings().group = policy.getSettings().direct;
  const socket = new FakeGateway();
  const posts = [], channelReads = [];
  let beforeRead;
  let reply;
  const provider = new DiscordApi({ token, fetchImpl: async (url, options) => {
    const match = /^\/api\/v10\/channels\/(\d+)\/messages$/u.exec(url.pathname);
    assert.ok(match, 'only Discord send is mocked here');
    assert.equal(options.method, 'POST');
    posts.push({ channelId: match[1], body: JSON.parse(options.body) });
    return await reply?.(options.signal) ?? Response.json({ id: String(posts.length) });
  } });
  const config = { botId, platformId, tokenRef: 'fake-token', name: 'Goal bot', liveText: false };
  const scope = createBotWorkspaceScope({ ensureRunning: async () => true }, { botId, workspaces, state });
  const logger = { warn() {}, error() {}, info() {} };
  const runtime = new DiscordRuntime({
    config, token, ...scope, accessPolicy: policy, logger,
    createApi: () => ({
      getCurrentUser: async () => ({ id: platformId, bot: true }),
      getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
      async getChannel({ channelId: id, signal }) {
        channelReads.push(id);
        return await beforeRead?.(signal) ?? { id, type: thread && id === channelId ? 11 : 0 };
      },
      createMessage: options => provider.createMessage(options),
    }),
    createWebSocket: () => {
      queueMicrotask(() => socket.receive({ op: 10, d: { heartbeat_interval: 45_000 } }));
      return socket;
    },
  });
  controller = new DiscordController({
    configStore: { list: () => [config], get: id => id === botId ? config : null,
      save() { assert.fail('unexpected bot config write'); }, remove() { assert.fail('unexpected bot config removal'); } },
    credentials: { resolve: async () => ({ value: token }),
      set() { assert.fail('unexpected credential write'); }, unset() { assert.fail('unexpected credential removal'); } },
    inspectOwner: async () => null, createRuntime: async () => runtime, logger,
  });
  const service = new DeliveryService({ unavailableSessionSyncChannels: remote ? ['discord'] : [], logger });
  service.registerAdapter(createDeliveryAdapter({
    channel: 'discord', workspaces, coreController: controller, stateFor: async () => state,
  }));
  await controller.initialize();
  assert.equal(runtime.status.ready, true);
  const addResearchTarget = async () => {
    await state.setSession(researchKey, sessionId);
    await service.createTarget(botId, { targetId: 'research', name: 'Research elsewhere', kind: 'channel', route: { channelId: researchId } });
    await service.setSessionSync(botId, 'research', true);
  };
  return {
    service, state, statePath, posts, channelReads, addResearchTarget, remember,
    resolve: (id = sessionId) => service.resolveDiscordGoalRoute(id),
    setLookup(fn) { beforeRead = fn; },
    setReply(fn) { reply = fn; },
    revokeActor() { policy.getSettings().group.allowlist.users[0].canExecuteCommands = false; },
  };
}

for (const thread of [false, true]) {
  test(`Discord Goal reaches only its bound ${thread ? 'thread' : 'group'} regardless of generic mirroring`, async (t) => {
    const f = await fixture(t, { thread });
    await f.addResearchTarget();
    const list = f.service.listSessionSyncTargets.bind(f.service);
    let master = false;
    const generic = t.mock.method(f.service, 'listSessionSyncTargets', id => master ? list(id) : []);
    assert.deepEqual(await f.service.listSessionSyncTargets(sessionId), []);
    const original = await f.resolve();
    assert.equal(original.conversationKey, key);
    const coordinator = createSessionSyncCoordinator({
      deliveryService: f.service,
      loadSettings: () => ({ deliverModelAnswers: master }),
      liveSegments: () => true,
    });
    t.after(() => coordinator.close());
    const goal = { id: authority.goalId, revision: authority.revision, phase: 'active' };
    const events = [{ type: 'goal/change', seq: authority.goalStartSeq, data: { operation: 'create', goal } }];
    const session = { snapshotEvents: () => events };
    let seq = authority.deliverySeqFloor;
    const completeRound = async (turn, text) => {
      for (const [type, data] of [
        ['turn/start', { turn }],
        ['user/message', { source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: turn } }],
        ['assistant/message', { turn, message: { content: [{ type: 'text', text }] } }],
        ['turn/end', { turn, reason: { kind: 'completed' } }],
      ]) {
        const event = { type, data, seq: ++seq, surfaceOp: 'append' };
        events.push(event);
        await coordinator.enqueue(sessionId, event, 'other', session);
      }
      return events.at(-1);
    };
    const first = await completeRound(1, '**first round**');
    master = true;
    assert.deepEqual((await f.service.listSessionSyncTargets(sessionId)).map(target => target.targetId), ['research']);
    const second = await completeRound(2, '**second round**');
    await coordinator.enqueue(sessionId, second, 'other', session);
    await coordinator.enqueue(sessionId, first, 'other', session);
    assert.deepEqual(f.posts.map(({ channelId: id, body }) => [id, body.content, body.allowed_mentions.parse]), [
      [channelId, '**first round**', []], [channelId, '**second round**', []],
    ]);
    assert.equal(generic.mock.callCount(), 2, 'only the test called generic target selection');
    const persisted = await new DiscordStateStore(f.statePath).load();
    assert.equal(persisted.goalOutputRouteFor(key).deliverySeqCursor, second.seq);
  });
}

test('plain bindings and mirror targets do not grant Discord Goal output authority', async (t) => {
  const f = await fixture(t, { saveAuthority: false });
  await f.addResearchTarget();
  assert.equal(await f.resolve(), null);
  assert.equal(await f.resolve('foreign-session'), null);
  assert.equal(await f.service.deliverDiscordGoalText({ ...authority, botId, conversationKey: key }, 11, 'no proof'), false);
  assert.deepEqual(f.posts, []);
});

test('Discord Goal refuses a foreign channel response or a revoked initiating actor before claiming', async (t) => {
  const f = await fixture(t);
  const route = await f.resolve();
  f.setLookup(() => ({ id: researchId, type: 0 }));
  assert.equal(await f.service.deliverDiscordGoalText(route, 11, 'wrong provider route'), false);
  f.setLookup(undefined);
  await f.state.rememberAuthor(key, { senderId: replacementActor, isBot: false });
  f.revokeActor();
  assert.equal(await f.service.deliverDiscordGoalText(route, 11, 'revoked actor'), false);
  assert.deepEqual(f.channelReads, [channelId]);
  assert.equal(f.state.goalOutputRouteFor(key).deliverySeqCursor, 10);
  assert.deepEqual(f.posts, []);
});

test('Discord Goal refuses ambiguous route authority and stale routes after an ABA rebind', async (t) => {
  const f = await fixture(t);
  const route = await f.resolve();
  await f.state.setSession(researchKey, sessionId);
  assert.equal(await f.remember(researchKey), true);
  assert.deepEqual(await f.resolve(), { ambiguous: true });
  assert.equal(await f.service.deliverDiscordGoalText(route, 11, 'now ambiguous'), false);
  await f.state.clearSession(researchKey);
  await f.state.setSession(key, 'replacement-session');
  await f.state.setSession(key, sessionId);
  assert.equal(await f.resolve(), null);
  assert.equal(await f.service.deliverDiscordGoalText(route, 11, 'stale route'), false);
  assert.deepEqual(f.posts, []);
});

test('a remote Discord Harness cannot target its locally stored Goal route', async (t) => {
  const f = await fixture(t, { remote: true });
  assert.ok(f.state.goalOutputRouteFor(key));
  assert.equal(await f.resolve(), null);
  assert.deepEqual(f.posts, []);
});

for (const stop of ['goal replaced', 'sender cancelled']) {
  test(`Discord Goal stops before claiming if ${stop} during channel lookup`, async (t) => {
    const f = await fixture(t);
    const started = Promise.withResolvers();
    const gate = Promise.withResolvers();
    f.setLookup(async () => { started.resolve(); return gate.promise; });
    const signal = new AbortController();
    let current = true;
    const result = f.service.deliverDiscordGoalText(await f.resolve(), 11, 'late output', {
      signal: signal.signal, assertGoalCurrent: () => current,
    });
    await started.promise;
    if (stop === 'goal replaced') current = false;
    else signal.abort();
    gate.resolve({ id: channelId, type: 0 });
    assert.equal(await result, false);
    assert.equal(f.state.goalOutputRouteFor(key).deliverySeqCursor, 10);
    assert.deepEqual(f.posts, []);
  });
}

test('Discord Goal checks authority again before the second Markdown chunk', async (t) => {
  const f = await fixture(t);
  let current = true;
  f.setReply(() => { current = false; return Response.json({ id: 'first-chunk' }); });
  const route = await f.resolve();
  await assert.rejects(f.service.deliverDiscordGoalText(route, 11, 'abc '.repeat(800), {
    assertGoalCurrent: () => current,
  }), { code: 'stale-route' });
  assert.equal(f.posts.length, 1);
  assert.equal(f.state.goalOutputRouteFor(key).deliverySeqCursor, 11, 'the attempted dispatch is still fenced');
  assert.equal(await f.service.deliverDiscordGoalText(route, 11, 'never retry a partial send'), false);
});

test('Discord Goal preserves a known 429 and prevents replay after an uncertain send', async (t) => {
  const f = await fixture(t);
  const route = await f.resolve();
  f.setReply(() => Response.json({ code: 0, retry_after: 4 }, { status: 429 }));
  await assert.rejects(f.service.deliverDiscordGoalText(route, 11, 'rate limited'), error => {
    assert.equal(error.code, 'delivery-failed');
    assert.equal(error.cause.status, 429);
    assert.equal(error.cause.retryAfter, 4);
    return true;
  });
  assert.equal(f.posts.length, 1, 'the Discord API must not invisibly retry behind the route guard');
  f.setReply(() => { throw new TypeError('mock connection was lost after dispatch'); });
  await assert.rejects(f.service.deliverDiscordGoalText(route, 12, 'uncertain'), { code: 'send-result-unknown' });
  assert.equal(await f.service.deliverDiscordGoalText(route, 12, 'uncertain'), false);
  assert.equal(f.posts.length, 2);
});
