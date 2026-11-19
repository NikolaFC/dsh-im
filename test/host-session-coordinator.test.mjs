import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  createHarnessSessionExecutors,
} from '../plugin-src/host/harness-session-coordinator.mjs';
import { modernHarnessApi } from '../plugin-src/host/modern-harness-api.mjs';
import { assertPathMatches } from './support/filesystem.mjs';

function contextWith(registry) {
  return { get: (name) => name === 'agents' ? registry : undefined };
}

function liveAgent(overrides = {}) {
  const calls = [];
  const agent = {
    status: 'running',
    session: {
      events: [
        { seq: 1, type: 'turn/start', data: { turn: 6 } },
        { seq: 2, type: 'user/message', data: { source: { rpcId: 'older' } } },
        { seq: 3, type: 'turn/end', data: { turn: 6, reason: 'completed' } },
        { seq: 4, type: 'turn/start', data: { turn: 7 } },
        { seq: 5, type: 'user/message', data: { source: { rpcId: 'prompt-owned' } } },
      ],
    },
    cancel(...args) { calls.push(['cancel', ...args]); },
    inject(...args) { calls.push(['inject', ...args]); },
    steer() { throw new Error('agent.steer must never be called'); },
    ...overrides,
  };
  return { agent, calls };
}

test('Host control executor validates and mutates the exact open owned turn synchronously', () => {
  const { agent, calls } = liveAgent();
  const registry = { get: (sessionId) => sessionId === 'session-one' ? agent : undefined };
  const { controlExecutor } = createHarnessSessionExecutors(contextWith(registry));

  assert.equal(controlExecutor({
    sessionId: 'session-one',
    expectedTurn: 7,
    promptRpcId: 'prompt-owned',
    inputRpcId: 'steer-one',
    action: 'steer',
    text: '先检查日志\n再继续',
  }), true);
  assert.equal(calls.length, 1, 'inject must finish before the executor returns');
  const message = calls[0][1];
  assert.equal(calls[0][0], 'inject');
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: '先检查日志\n再继续' }]);
  assert.deepEqual(message.source, { kind: 'user', rpcId: 'steer-one' });
  assert.match(message.id, /^[0-9a-f-]{36}$/i);
  assert.equal(Object.isFrozen(message), true);
  assert.equal(Object.isFrozen(message.content), true);
  assert.equal(Object.isFrozen(message.content[0]), true);

  assert.equal(controlExecutor({
    sessionId: 'session-one',
    expectedTurn: 7,
    promptRpcId: 'prompt-owned',
    action: 'stop',
  }), true);
  assert.deepEqual(calls[1], ['cancel', { kind: 'user' }, { keepInbox: true }]);
});

test('Host control executor reads modern Session event snapshots', () => {
  const { agent, calls } = liveAgent({
    session: {
      snapshotEvents: () => Object.freeze([
        { seq: 1, type: 'turn/start', data: { turn: 7 } },
        { seq: 2, type: 'user/message', data: { source: { rpcId: 'prompt-owned' } } },
      ]),
    },
  });
  const { controlExecutor } = createHarnessSessionExecutors(
    contextWith({ get: () => agent }),
  );

  assert.equal(controlExecutor({
    sessionId: 'session-one',
    expectedTurn: 7,
    promptRpcId: 'prompt-owned',
    action: 'stop',
  }), true);
  assert.deepEqual(calls, [['cancel', { kind: 'user' }, { keepInbox: true }]]);
});

test('Host steering refuses a cancelled loop while its turn is still open', () => {
  const abort = new AbortController();
  const { agent, calls } = liveAgent({
    phase: { kind: 'running', abort },
    cancel() { abort.abort(); },
  });
  const { controlExecutor } = createHarnessSessionExecutors(contextWith({ get: () => agent }));
  const control = { sessionId: 'session-one', boundSession: () => true };
  const request = { action: 'steer', inputRpcId: 'running-steer', text: 'a follow-up' };
  assert.equal(controlExecutor({ ...control, ...request }), true);
  assert.equal(controlExecutor({ ...control, action: 'stop' }), true);
  assert.equal(agent.status, 'running', 'the host has not unwound the turn yet');
  assert.equal(controlExecutor({ ...control, ...request }), false);
  assert.equal(controlExecutor({
    sessionId: 'session-one', expectedTurn: 7, promptRpcId: 'prompt-owned', ...request,
  }), false);
  assert.equal(calls.length, 1);
});

test('Host steering preserves native questions when no IM route is available', async (t) => {
  const { agent, calls } = liveAgent();
  agent.session.id = 'session-one';
  const listeners = new Map();
  const ctx = {
    ...contextWith({ get: () => agent }),
    root: {},
    typertGateway: { invoke() {}, stream() {} },
    on(type, listener) {
      listeners.set(type, listener);
      return () => listeners.delete(type);
    },
  };
  const api = modernHarnessApi(ctx, {
    deliveryService: { presentSessionSyncQuestion: async () => false },
  });
  t.after(() => api.dispose());
  const { controlExecutor } = createHarnessSessionExecutors(ctx);
  const request = { sessionId: agent.session.id, boundSession: () => true,
    action: 'steer', inputRpcId: 'running-steer', text: 'a follow-up' };
  const controller = new AbortController();
  let resolveNative;
  const native = new Promise((resolve) => { resolveNative = resolve; });
  const question = listeners.get('user-questions/request')({
    agent, questions: [{ id: 'choice', question: 'Continue?' }], signal: controller.signal,
  }, () => native);
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => controlExecutor(request), { code: 'harness-question-pending' });
  assert.equal(calls.length, 0, 'an ordinary message must not enter the waiting turn');
  const answer = { answers: [{ id: 'choice', selected: [], custom: 'yes' }] };
  resolveNative(answer);
  assert.deepEqual(await question, answer);
  assert.equal(controlExecutor(request), true);
  assert.equal(calls.length, 1);
});

test('Host control executor refuses idle, replaced, closed, and foreign turns without waking', () => {
  const { agent, calls } = liveAgent();
  const { controlExecutor } = createHarnessSessionExecutors(contextWith({ get: () => agent }));
  const request = {
    sessionId: 'session-one',
    expectedTurn: 7,
    promptRpcId: 'prompt-owned',
    inputRpcId: 'steer-refused',
    action: 'steer',
    text: 'must not wake',
  };

  assert.equal(controlExecutor({ ...request, promptRpcId: 'foreign' }), false);
  assert.equal(controlExecutor({ ...request, expectedTurn: 6 }), false);
  agent.status = 'idle';
  assert.equal(controlExecutor(request), false);
  agent.status = 'running';
  agent.session.events.push(
    { seq: 6, type: 'turn/end', data: { turn: 7, reason: 'cancelled' } },
    { seq: 7, type: 'turn/start', data: { turn: 8 } },
    { seq: 8, type: 'user/message', data: { source: { rpcId: 'someone-else' } } },
  );
  assert.equal(controlExecutor(request), false);
  assert.deepEqual(calls, []);
});

test('goal steering requires exact retained prompt and uninterrupted same-goal turns', () => {
  const { agent, calls } = liveAgent();
  const anchor = [...agent.session.events,
    { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } }];
  const goal = (turn, goalId = 'goal-one') => [
    { type: 'turn/start', data: { turn } },
    { type: 'user/message', data: { source: { kind: 'goal', goalId, round: turn - 7 } } },
  ];
  const end = turn => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  const { controlExecutor } = createHarnessSessionExecutors(contextWith({ get: () => agent }));
  const request = { sessionId: 'session-one', promptRpcId: 'prompt-owned', continuationAfterTurn: 7,
    action: 'steer', inputRpcId: 'goal-steer', text: 'new instruction' };
  agent.session.events = [...anchor, ...goal(8)];
  assert.equal(controlExecutor(request), true);
  assert.equal(controlExecutor({ ...request, promptRpcId: 'foreign' }), false);
  assert.equal(controlExecutor({ ...request, continuationAfterTurn: 6 }), false);
  assert.equal(controlExecutor({ ...request, action: 'stop' }), false);
  agent.session.events.push(end(8), ...goal(9));
  assert.equal(controlExecutor(request), true);
  // A follow-up injected into the same goal turn does not replay the old input.
  agent.session.events.push({ type: 'user/message', data: { source: { kind: 'user', rpcId: 'goal-steer' } } });
  assert.equal(controlExecutor(request), true);
  for (const events of [
    [...anchor],
    [...anchor, ...goal(8), end(8)],
    [...anchor, ...goal(8), end(8), ...goal(9, 'different-goal')],
    [...anchor, { type: 'turn/start', data: { turn: 8 } }],
    [...anchor, { type: 'turn/start', data: { turn: 8 } }, end(8), ...goal(9)],
    [...anchor, { type: 'turn/start', data: { turn: 8 } },
      { type: 'user/message', data: { source: { kind: 'user', rpcId: 'manual' } } }, end(8), ...goal(9)],
    [...anchor, ...goal(8), { type: 'turn/end', data: { turn: 8, reason: 'cancelled' } }, ...goal(9)],
    [...goal(8)],
  ]) {
    agent.session.events = events;
    assert.equal(controlExecutor(request), false, JSON.stringify(events));
  }
  agent.session.events = [...anchor, ...goal(8)];
  agent.status = 'idle';
  assert.equal(controlExecutor(request), false);
  assert.equal(calls.length, 3, 'refused controls neither inject nor cancel');
});

test('Host executors preserve HTTP fallback when AgentRegistry or attachment is absent', async () => {
  const withoutRegistry = createHarnessSessionExecutors({});
  assert.equal(withoutRegistry.controlExecutor, undefined);
  assert.equal(withoutRegistry.sessionMaintenanceExecutor, undefined);
  assert.equal(typeof withoutRegistry.fileIngressExecutor, 'function');
  const inaccessibleRegistry = createHarnessSessionExecutors({
    get() { throw new Error('not injected'); },
  });
  assert.equal(inaccessibleRegistry.controlExecutor, undefined);
  assert.equal(inaccessibleRegistry.sessionMaintenanceExecutor, undefined);
  assert.equal(typeof inaccessibleRegistry.fileIngressExecutor, 'function');

  const { controlExecutor, sessionMaintenanceExecutor } = createHarnessSessionExecutors(
    contextWith({ get: () => undefined }),
  );
  assert.equal(controlExecutor({
    sessionId: 'cold-session', expectedTurn: 1, promptRpcId: 'rpc', action: 'stop',
  }), undefined);
  let operated = false;
  assert.equal(await sessionMaintenanceExecutor({
    sessionId: 'cold-session',
    operation: async (signal) => {
      operated = true;
      assert.equal(signal, undefined);
      return 'fallback';
    },
  }), 'fallback');
  assert.equal(operated, true);
});

test('Host file ingress stages bytes in the exact attached Session cwd', async (t) => {
  const defaultWorkspace = await mkdtemp(join(tmpdir(), 'dsh-im-default-cwd-'));
  const sessionWorkspace = await mkdtemp(join(tmpdir(), 'dsh-im-session-cwd-'));
  t.after(() => Promise.all([
    rm(defaultWorkspace, { recursive: true, force: true }),
    rm(sessionWorkspace, { recursive: true, force: true }),
  ]));
  const agent = {
    session: {
      header: { id: 'session-exact-cwd', cwd: sessionWorkspace },
      events: [],
    },
  };
  const registry = {
    get: (sessionId) => sessionId === 'session-exact-cwd' ? agent : undefined,
  };
  const { fileIngressExecutor } = createHarnessSessionExecutors(contextWith(registry));

  const staged = await fileIngressExecutor({
    sessionId: 'session-exact-cwd',
    workspace: defaultWorkspace,
    files: [{ name: 'attached.txt', data: Buffer.from('session bytes') }],
  });

  assert.equal(staged.files.length, 1);
  assert.equal(staged.files[0].name, 'attached.txt');
  assertPathMatches(staged.files[0].path, /^\.dsh-im\/inbound\/\d{8}-\d{6}-[^/]+\/01-attached\.txt$/);
  assert.equal(
    await readFile(resolve(sessionWorkspace, staged.files[0].path), 'utf8'),
    'session bytes',
  );
  await assert.rejects(
    readFile(resolve(defaultWorkspace, staged.files[0].path)),
    /ENOENT/,
    'the plugin/default workspace must not receive another Session attachment',
  );
  await staged.cleanup();
});

test('Host file ingress uses session.list cwd while the Session is still cold', async (t) => {
  const sessionWorkspace = await mkdtemp(join(tmpdir(), 'dsh-im-cold-session-cwd-'));
  t.after(() => rm(sessionWorkspace, { recursive: true, force: true }));
  const { fileIngressExecutor } = createHarnessSessionExecutors({});

  const staged = await fileIngressExecutor({
    sessionId: 'session-cold',
    workspace: sessionWorkspace,
    files: [{ name: 'cold.txt', data: Buffer.from('cold session bytes') }],
  });

  assert.equal(
    await readFile(resolve(sessionWorkspace, staged.files[0].path), 'utf8'),
    'cold session bytes',
  );
  await staged.cleanup();
});

test('Host maintenance executor claims idle synchronously and reports busy with a stable code', async () => {
  const maintenanceController = new AbortController();
  let operationStarted = false;
  const agent = {
    runMaintenance(operation) {
      operationStarted = true;
      return operation(maintenanceController.signal);
    },
  };
  const { sessionMaintenanceExecutor } = createHarnessSessionExecutors(
    contextWith({ get: () => agent }),
  );
  const value = sessionMaintenanceExecutor({
    sessionId: 'session-one',
    operation: async (signal) => {
      assert.equal(operationStarted, true);
      assert.equal(signal, maintenanceController.signal);
      return 'selected';
    },
  });
  assert.equal(operationStarted, true, 'maintenance must be claimed in the calling tick');
  assert.equal(await value, 'selected');

  const busy = new Error('already active');
  agent.runMaintenance = () => { throw busy; };
  assert.throws(() => sessionMaintenanceExecutor({
    sessionId: 'session-one', operation: async () => undefined,
  }), (error) => error?.code === 'agent-busy' && error.cause === busy);

  const rpcFailure = new Error('model unavailable');
  agent.runMaintenance = (operation) => operation(maintenanceController.signal);
  await assert.rejects(sessionMaintenanceExecutor({
    sessionId: 'session-one', operation: async () => { throw rpcFailure; },
  }), (error) => error === rpcFailure, 'async RPC failures must not be mislabeled as busy');
});
