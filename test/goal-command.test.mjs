import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoalCommand, runGoalCommand } from '../src/channels/shared/goal-command.mjs';
import { createHarnessCommandExecutor } from '../plugin-src/host/harness-command-executor.mjs';
import { discordCommandChoices, DiscordCommandPickers } from '../src/channels/discord/discord-command-picker.mjs';
import { discordCommandText, DISCORD_APPLICATION_COMMANDS } from '../src/channels/discord/discord-interactions.mjs';
import { DiscordHarnessBridge } from '../src/channels/discord/discord-bridge.mjs';
import { isSharedLocalCommand } from '../src/channels/shared/command-permission.mjs';

const initial = { id: 'goal-mock', revision: 7, phase: 'active', activation: 'armed', objective: 'mock objective', roundsStarted: 2, maxGoalRounds: 8 };
function fixture(start = initial) {
  let current = start;
  const calls = [];
  const peer = { principal: { kind: 'owner' } };
  const execute = createHarnessCommandExecutor({ connection: { createPeer: () => peer }, typertGateway: { invoke: async call => {
    calls.push(call);
    assert.equal(call.namespace, 'goals');
    assert.equal(call.peer, peer);
    if (call.method === 'get') return current;
    if (call.method === 'create') {
      current = { ...initial, ...call.args.request, roundsStarted: 0, revision: 1 };
      return { ref: { id: current.id, revision: 1 } };
    }
    assert.deepEqual(call.args.ref, { id: current.id, revision: current.revision });
    current = { ...current, phase: call.method === 'pause' ? 'paused' : 'active', activation: call.method === 'pause' ? 'disarmed' : 'armed', revision: current.revision + 1 };
    return current;
  } } });
  const state = { sessionFor: key => key === 'group:thread' ? 'session-thread' : null };
  const harness = { workspaceSession: (id, key) => {
    assert.equal(id, 'session-thread'); assert.equal(key, 'group:thread');
    return { executeCommand: (line, options) => execute(id, line, options) };
  } };
  return { calls, execute, state, harness };
}

test('goal grammar rejects invalid caps, line breaks and attachments', async () => {
  assert.equal(parseGoalCommand('/goals'), null);
  for (const text of ['/goal create --rounds 0 x', '/goal create --rounds 257 x', '/goal create --rounds 2.5 x', '/goal create --rounds 1e2 x', '/goal create x\n/stop', `/goal create ${'x'.repeat(1001)}`, '/goal --rounds 3 x']) assert.equal(parseGoalCommand(text).action, 'invalid', text);
  assert.deepEqual(parseGoalCommand('/goal create --rounds 3 mock objective'), { action: 'create', request: { objective: 'mock objective', maxGoalRounds: 3 } });
  assert.equal(parseGoalCommand('/goal create').action, 'help');
  const f = fixture();
  await runGoalCommand('/goal pause', f.harness, f.state, 'group:thread', { hasFiles: true });
  assert.equal(f.calls.length, 0);
});

test('a bare objective after /goal is the short spelling of create', () => {
  // The first thing a person types: `/goal <objective>`, no `create` keyword.
  assert.deepEqual(parseGoalCommand('/goal 把论文改完'), { action: 'create', request: { objective: '把论文改完', maxGoalRounds: 256 } });
  assert.deepEqual(parseGoalCommand('/goal fix the flaky test'), { action: 'create', request: { objective: 'fix the flaky test', maxGoalRounds: 256 } });
  // Reserved words keep their meanings, and `create` remains the explicit form.
  assert.equal(parseGoalCommand('/goal status').action, 'status');
  assert.equal(parseGoalCommand('/goal pause').action, 'pause');
  assert.equal(parseGoalCommand('/goal resume').action, 'resume');
  assert.equal(parseGoalCommand('/goal create').action, 'help');
  assert.equal(parseGoalCommand(`/goal ${'y'.repeat(1001)}`).action, 'invalid');
  assert.equal(parseGoalCommand('/goal 目标\r\n第二行').action, 'invalid');
});

test('status and mutations use exact channel session and goal revision through Host gateway', async () => {
  const f = fixture();
  const status = await runGoalCommand('/goal', f.harness, f.state, 'group:thread');
  assert.match(status.message, /mock objective/);
  assert.deepEqual(f.calls.map(call => call.method), ['get']);
  await runGoalCommand('/goal pause', f.harness, f.state, 'group:thread');
  await runGoalCommand('/goal resume', f.harness, f.state, 'group:thread');
  assert.deepEqual(f.calls.map(call => call.method), ['get', 'get', 'pause', 'get', 'resume']);
  assert.ok(f.calls.every(call => call.args.agentId === 'session-thread'));
  assert.equal(f.calls.at(-1).args.ref.revision, 8);
});

test('explicit create uses bounded request, reads resulting state, never dispatches commands/chat', async () => {
  const f = fixture(null);
  const result = await runGoalCommand('/goal create --rounds 4 mock objective', f.harness, f.state, 'group:thread');
  assert.deepEqual(f.calls.map(call => call.method), ['get', 'create', 'get']);
  assert.deepEqual(f.calls[1].args, { agentId: 'session-thread', request: { objective: 'mock objective', maxGoalRounds: 4 } });
  assert.equal(result.goal.maxGoalRounds, 4);
});

test('unbound and unsupported commands return local errors; no arbitrary/latest session fallback', async () => {
  const f = fixture();
  await runGoalCommand('/goal resume', f.harness, f.state, 'group:other');
  assert.equal(f.calls.length, 0);
  const result = await runGoalCommand('/goal resume', { executeCommand: () => assert.fail('unscoped fallback') }, f.state, 'group:thread');
  assert.match(result.message, /暂不支持/);
});

test('an unbound conversation creates its goal by opening and binding a Session', async () => {
  const bindings = new Map();
  const calls = [];
  const state = {
    sessionFor: key => bindings.get(key) ?? null,
    setSession: async (key, sessionId) => { bindings.set(key, sessionId); return true; },
  };
  const harness = {
    createSession: async options => { calls.push(['createSession', options]); return 'session-fresh'; },
    workspaceSession: (sessionId, key) => ({
      executeCommand: async (line, options) => {
        options.assertSessionBound();
        calls.push(['execute', sessionId, key, line]);
        return { result: { kind: 'success', text: 'created mock goal' }, goal: { id: 'goal-fresh' } };
      },
    }),
  };
  const result = await runGoalCommand('/goal create --rounds 4 mock objective', harness, state, 'group:fresh', { signal: 'sig' });
  assert.equal(result.goal.id, 'goal-fresh');
  assert.equal(bindings.get('group:fresh'), 'session-fresh');
  assert.deepEqual(calls.map(call => call[0]), ['createSession', 'execute']);
  assert.deepEqual(calls[0][1], { conversationKey: 'group:fresh', signal: 'sig' });
  assert.deepEqual(calls[1].slice(1), ['session-fresh', 'group:fresh', '/goal create --rounds 4 mock objective']);
});

test('an unbound conversation reads a goal without silently opening a Session', async () => {
  const bindings = new Map();
  let created = 0;
  const state = {
    sessionFor: key => bindings.get(key) ?? null,
    setSession: async (key, sessionId) => { bindings.set(key, sessionId); return true; },
  };
  const harness = {
    createSession: async () => { created += 1; return 'session-fresh'; },
    workspaceSession: () => ({ executeCommand: () => assert.fail('no Session may be opened for a read') }),
  };
  for (const command of ['/goal', '/goal status', '/goal pause', '/goal resume']) {
    const result = await runGoalCommand(command, harness, state, 'group:fresh');
    assert.match(result.message, /绑定会话|bound/iu, command);
  }
  assert.equal(created, 0);
  assert.equal(bindings.size, 0);
});

test('a failed Session creation leaves the conversation unbound and submits no goal', async () => {
  const state = { sessionFor: () => null, setSession: (key, sessionId) => { state.bound = sessionId; return true; } };
  const harness = {
    createSession: async () => { throw Object.assign(new Error('workspace vanished'), { code: 'session-create-failed' }); },
    workspaceSession: () => ({ executeCommand: () => assert.fail('no goal may be submitted without a Session') }),
  };
  const result = await runGoalCommand('/goal create mock objective', harness, state, 'group:fresh');
  assert.match(result.message, /session-create-failed/);
  assert.equal(state.bound, undefined);
});

test('binding switch between read and write prevents goal mutation', async () => {
  let binding = 'session-thread';
  const calls = [];
  const execute = createHarnessCommandExecutor({ typertGateway: { invoke: async call => {
    calls.push(call); binding = 'session-other'; return initial;
  } } });
  const result = await runGoalCommand('/goal pause', { workspaceSession: id => ({ executeCommand: (line, opts) => execute(id, line, opts) }) },
    { sessionFor: () => binding }, 'group:thread');
  assert.deepEqual(calls.map(call => call.method), ['get']);
  assert.match(result.message, /workspace-session-stale/);
});

test('host errors are surfaced without retrying a mutation', async () => {
  let calls = 0;
  const execute = createHarnessCommandExecutor({ typertGateway: { invoke: async call => {
    calls++;
    if (call.method === 'get') return initial;
    throw Object.assign(new Error('stale'), { code: 'GOAL_STALE_REVISION' });
  } } });
  const result = await runGoalCommand('/goal pause', { workspaceSession: id => ({ executeCommand: (line, opts) => execute(id, line, opts) }) },
    { sessionFor: () => 's' }, 'group:thread');
  assert.equal(calls, 2); assert.match(result.message, /GOAL_STALE_REVISION/);
});

test('native goal fields have explicit actions and validated objective/rounds', () => {
  const definition = DISCORD_APPLICATION_COMMANDS.find(item => item.name === 'goal');
  assert.deepEqual(definition.options[0].choices.map(item => item.value), ['status', 'create', 'pause', 'resume']);
  const data = options => ({ type: 1, name: 'goal', options });
  const action = { name: 'action', type: 3, value: 'create' };
  assert.equal(discordCommandText(data([])), '/goal');
  assert.equal(discordCommandText(data([action])), '/goal create');
  assert.equal(discordCommandText(data([action, { name: 'objective', type: 3, value: 'mock objective' }, { name: 'rounds', type: 4, value: 5 }])), '/goal create --rounds 5 mock objective');
  for (const options of [[action, action], [{ ...action, value: 'delete' }], [action, { name: 'rounds', type: 4, value: 0 }], [action, { name: 'objective', type: 3, value: 'x\n/stop' }], [{ name: 'objective', type: 3, value: 'x' }]]) assert.equal(discordCommandText(data(options)), null);
});

test('empty goal picker includes current status and only meaningful state actions', async () => {
  const f = fixture();
  const panel = await discordCommandChoices('goal', f.harness, f.state, 'group:thread');
  assert.match(panel.content, /mock objective/);
  assert.deepEqual(panel.choices.map(item => item.command), ['/goal status', '/goal pause']);
  const pickers = new DiscordCommandPickers();
  const message = { senderId: 'owner', kind: 'group', conversationId: 'thread' };
  const card = pickers.issue(message, panel.choices, 'session-thread', panel.content);
  assert.match(card.content, /mock objective/);
  const press = { ...message, data: card.components[0].components[0].custom_id, componentType: 3, values: ['1'] };
  assert.equal(pickers.claim(press, 'wrong-session'), null);
  assert.equal(pickers.claim(press, 'session-thread'), '/goal pause');
  assert.equal(pickers.claim(press, 'session-thread'), null);
});

test('an unbound goal picker still offers creation and says how to create', async () => {
  const panel = await discordCommandChoices('goal',
    { workspaceSession: () => assert.fail('a picker read opens no Session') },
    { sessionFor: () => null }, 'group:fresh');
  assert.match(panel.content, /绑定会话/);
  assert.match(panel.content, /\/goal create/);
  assert.deepEqual(panel.choices.map(item => item.command), ['/goal status', '/goal create']);
});

test('Discord bridge recognizes goal as control, never submits it to model; access matcher recognizes attachments too', async () => {  const f = fixture();
  let reply;
  const bridge = new DiscordHarnessBridge({ harness: { ...f.harness, ask: () => assert.fail('goal sent as chat') },
    state: { ...f.state, hasSeen: () => false, markSeen: async () => {} },
    bot: { sendText: async (_, text) => { reply = text; } } });
  await bridge.accept({ messageId: 'goal-command', senderId: 'owner', kind: 'group', conversationId: 'thread', addressed: true, content: '/goal status', replyTarget: {} });
  assert.match(reply, /mock objective/);
  assert.deepEqual(f.calls.map(call => call.method), ['get']);
  assert.equal(isSharedLocalCommand('/goal pause', { hasFiles: true }), true);
});
