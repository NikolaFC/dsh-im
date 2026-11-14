import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';
import { createBoundConversationControl } from '../src/channels/shared/bound-conversation-control.mjs';
import { HarnessClient } from '../src/channels/shared/harness-client.mjs';
import { createHarnessSessionExecutors } from '../plugin-src/host/harness-session-coordinator.mjs';
import { DiscordHarnessBridge } from '../src/channels/discord/discord-bridge.mjs';
import { normalizeDiscordInteraction, DISCORD_COMMAND_GUILD } from '../src/channels/discord/discord-interactions.mjs';

async function fixture() {
  const state = new ConversationStateStore(join(await mkdtemp(join(tmpdir(), 'bound-control-')), 'state.json'));
  await state.setSession('group:game', 'game');
  let allowed = true;
  const policy = { isPrivileged: ids => allowed && ids.includes('owner'), getSettings: () => null };
  const abort = new AbortController();
  const control = { owner: {}, key: 'group:game', boundSession: createBoundConversationControl({
    channel: 'discord', state, key: 'group:game', message: { kind: 'group', conversationId: 'game', senderId: 'owner', addressed: true }, accessPolicy: policy, signal: abort.signal,
  }) };
  const calls = [];
  const agent = { status: 'running', session: { events: [
    { type: 'turn/start', data: { turn: 8 } },
    { type: 'user/message', data: { source: { kind: 'goal', goalId: 'g' } } },
  ] }, inject: message => calls.push(['inject', message]), cancel: (...args) => calls.push(['cancel', ...args]) };
  const executors = createHarnessSessionExecutors({ get: name => name === 'agents' ? { get: id => id === 'game' ? agent : undefined } : undefined });
  const client = new HarnessClient({ baseUrl: 'http://localhost:1', workspace: 'C:/AI', ...executors });
  client.rpc = () => { throw new Error('bound controls must never fall back to HTTP'); };
  return { state, control, agent, calls, client, abort, policy, deny: () => { allowed = false; } };
}

test('authenticated exact Discord binding steers and stops existing goal or GUI turns without ask anchor', async () => {
  const f = await fixture();
  assert.equal(await f.client.steerActiveTurn('game', 'hello', f.control), true);
  f.agent.session.events[1].data.source = { kind: 'user', rpcId: 'gui' };
  assert.equal(await f.client.stopActiveTurn('game', f.control), true);
  assert.deepEqual(f.calls.map(c => c[0]), ['inject', 'cancel']);
});

test('bound controls refuse wrong session, denied actor, ACL changes, rebind ABA and abort', async () => {
  for (const mutate of [
    async f => { await f.state.setSession('group:game', 'other'); },
    async f => { await f.state.setSession('group:game', 'other'); await f.state.setSession('group:game', 'game'); },
    async f => f.deny(),
    async f => f.abort.abort(),
  ]) {
    const f = await fixture(); await mutate(f);
    await assert.rejects(f.client.steerActiveTurn('game', 'hello', f.control));
    assert.deepEqual(f.calls, []);
  }
  const f = await fixture();
  await assert.rejects(f.client.stopActiveTurn('other', f.control));
  const denied = createBoundConversationControl({channel:'discord', state:f.state, key:'group:game', accessPolicy:f.policy,
    message:{kind:'group',conversationId:'game',senderId:'stranger',addressed:true}});
  assert.throws(() => denied('game'), {code:'im-control-denied'});
  assert.deepEqual(f.calls, []);
});

test('bound control has no cross-channel, cross-bot or unsigned-message authority', async () => {
  const f = await fixture();
  for (const overrides of [{ channel:'slack' }, {accessPolicy:null}, {key:'group:other'},
    {message:{kind:'group',conversationId:'game',senderId:'owner',addressed:false}},
    {message:{kind:'group',conversationId:'game',senderId:'owner',senderIsBot:true,addressed:true}}]) {
    assert.equal(createBoundConversationControl({channel:'discord',state:f.state,key:'group:game',accessPolicy:f.policy,
      message:{kind:'group',conversationId:'game',senderId:'owner',addressed:true},...overrides}), undefined);
  }
  const otherState = new ConversationStateStore({});
  const other = createBoundConversationControl({channel:'discord',state:otherState,key:'group:game',accessPolicy:f.policy,
    message:{kind:'group',conversationId:'game',senderId:'owner',addressed:true}});
  assert.equal(other, undefined);
});

test('native /steer slash and ordinary Discord message carry the same verified bound capability', async () => {
  const sent = [];
  const captured = [];
  const bridge = new DiscordHarnessBridge({
    logger: { warn() {}, error() {} },
    bot: { sendText: async (...args) => sent.push(args) },
    state: await (async () => { const dir = await mkdtemp(join(tmpdir(), 'bound-bridge-')); const store = await new ConversationStateStore(join(dir, 'state.json')).load(); await store.setSession('group:game', 'game'); return store; })(),
    accessPolicy: { isPrivileged: ids => ids.includes('owner'), getSettings: () => null },
    harness: {
      workspaceSession: () => ({
        steerActiveTurn: async (_text, control) => { captured.push(control); return true; },
        stopActiveTurn: async control => { captured.push(control); return true; },
        sessionExists: async () => true,
      }),
      ask: () => { throw new Error('control messages must not open a turn'); },
    },
  });
  const slash = normalizeDiscordInteraction({ id: 'i1', token: 't1', application_id: 'app',
    guild_id: DISCORD_COMMAND_GUILD, channel_id: 'game', member: { user: { id: 'owner' } }, type: 2,
    data: { type: 1, name: 'steer', options: [{ name: 'input', type: 3, value: '看下背包' }] } }, 'app');
  assert.equal(slash.content, '/steer 看下背包');
  await bridge.accept(slash);
  assert.equal(sent.length, 1, JSON.stringify(sent));
  assert.equal(sent[0][1], '已提交补充指令，Agent 会在下一步读取。');
  assert.equal(captured.length, 1);
assert.equal(typeof captured[0].boundSession, 'function');
  assert.equal(captured[0].boundSession('game'), true);
});


