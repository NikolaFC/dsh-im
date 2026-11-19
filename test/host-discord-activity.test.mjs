import assert from 'node:assert/strict';
import test from 'node:test';
import { observeDiscordActivity, createTypingDiagnostics } from '../plugin-src/host/discord-activity.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordBotClient, DiscordRuntime } from '../src/channels/discord/discord-runtime.mjs';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function events() {
  const listeners = new Map();
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    },
    emit(name, payload) { for (const fn of [...listeners.get(name) ?? []]) fn(payload); },
    count() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
  };
}
function fixture({ send } = {}) {
  let time = 0;
  let nextTimer = 0;
  let stops = 0;
  const timers = new Map();
  const bus = events();
  const live = new Map();
  const jobRows = new Map();
  const jobListeners = new Map();
  const bindings = {};
  const masked = new Set();
  const calls = [];
  const effects = [];
  const controller = new AbortController();
  const agents = {
    list: () => [...live.values()], get: (id) => live.get(id),
    isOwnedBy: (id, agent) => live.get(id)?.parent === agent,
  };
  const jobs = {
    list: (owner) => [...jobRows.values()].filter((j) => !j.owner || j.owner === owner),
    events: { subscribe({ owner }, fn) {
      if (!jobListeners.has(owner)) jobListeners.set(owner, new Set());
      jobListeners.get(owner).add(fn);
      return () => jobListeners.get(owner).delete(fn);
    } },
  };
  const ctx = { ...bus, get: (name) => ({ agents, jobs })[name], effect: (setup) => effects.push(setup()) };
  const state = { snapshot: () => ({ sessions: { ...bindings } }),
    sessionFor: (key) => masked.has(key) ? null : bindings[key] };
  const f = {
    ctx, state, calls, live, jobRows, timers, bindings, effects, masked,
    add(id, status = 'idle', parent) {
      const agent = { id, status, parent, ctx: events(), session: { header: { parentSession: 'irrelevant' } } };
      live.set(id, agent);
      bus.emit('agent/created', { agent });
      return agent;
    },
    status(agent, status) { agent.status = status; bus.emit('agent/status', { agent, status }); },
    remove(agent) { live.delete(agent.id); bus.emit('agent/disposed', { agent }); },
    bind(key, id) { if (id) bindings[key] = id; else delete bindings[key]; bus.emit('dsh-im/session-pre-bind'); },
    job(id, owner, status, type = 'registered') {
      const job = { id, owner, status, label: 'private label' };
      if (type === 'removed') jobRows.delete(id); else jobRows.set(id, job);
      for (const fn of jobListeners.get(owner) ?? []) fn({ type, job });
    },
    start() {
      return observeDiscordActivity(ctx, { state, signal: controller.signal,
        logger: { warn() {} }, diagnostics: (value) => f.diagnostics?.(value), sendTyping: (target) => { calls.push({ ...target, at: time }); return send?.(target); },
        now: () => time, onStop: () => { stops++; },
        setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: time + delay }); return id; },
        clearTimeout: (id) => timers.delete(id),
      });
    },
    async tick(ms) {
      const end = time + ms;
      while (true) {
        const row = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!row || row[1].at > end) break;
        time = row[1].at; timers.delete(row[0]); row[1].fn(); await flush();
      }
      time = end; await flush();
    },
    abort: () => controller.abort(),
    stops: () => stops,
    listenerCount: () => bus.count() + [...live.values()].reduce((n, a) => n + a.ctx.count(), 0)
      + [...jobListeners.values()].reduce((n, s) => n + s.size, 0),
  };
  return f;
}

test('idle parent follows running descendant and descendant job through completion', async () => {
  const f = fixture();
  const parent = f.add('parent');
  const child = f.add('child', 'running', parent);
  const grandchild = f.add('grandchild', 'idle', child);
  f.bind('group:111', parent.id);
  f.job('bg', grandchild.id, 'running');
  const close = f.start();
  await flush();
  assert.deepEqual(f.calls, [{ channelId: '111', at: 0 }]);
  f.status(child, 'idle');
  await f.tick(7_500);
  assert.equal(f.calls.length, 2);
  f.job('bg', grandchild.id, 'stopping', 'stopping');
  await f.tick(7_500);
  assert.equal(f.calls.length, 3);
  f.job('bg', grandchild.id, 'completed', 'settled');
  assert.equal(f.timers.size, 0);
  await f.tick(30_000);
  assert.equal(f.calls.length, 3);
  close(); assert.equal(f.listenerCount(), 0);
});

test('one pulse per channel every 7500ms despite parent/child/job and rapid restarts', async () => {
  const f = fixture(); const parent = f.add('parent', 'running');
  const child = f.add('child', 'running', parent);
  f.bind('group:111', parent.id); f.bind('direct:111', child.id);
  f.start(); await flush();
  f.job('bg', child.id, 'running');
  await f.tick(1_000);
  f.status(parent, 'idle'); f.status(child, 'idle'); f.job('bg', child.id, 'failed', 'settled');
  f.status(parent, 'running');
  await f.tick(6_499); assert.equal(f.calls.length, 1);
  await f.tick(1); assert.equal(f.calls.length, 2);
  f.abort(); assert.equal(f.timers.size, 0); assert.equal(f.listenerCount(), 0);
});

test('unrelated agents, durable forks, unowned jobs, paused goals and inactive queues are excluded', async () => {
  const f = fixture(); const parent = f.add('parent');
  f.add('unrelated', 'running'); const fork = f.add('fork', 'running');
  fork.session.header.parentSession = parent.id;
  parent.goal = { status: 'active' }; parent.inbox = { nextTurn: ['queued'] };
  f.bind('group:111', parent.id); f.job('unowned', undefined, 'running');
  f.start(); await flush(); await f.tick(30_000);
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  f.abort();
});

test('current channel binding, workspace masks and microtask disposal prevent stale routing', async () => {
  const f = fixture(); const parent = f.add('parent', 'running');
  f.bind('group:111', parent.id); f.bind('group:invalid', parent.id);
  f.start(); f.bind('group:111', 'unrelated'); await flush();
  assert.equal(f.calls.length, 0);
  f.bind('group:222', parent.id); await flush();
  assert.deepEqual(f.calls.map((c) => c.channelId), ['222']);
  f.masked.add('group:222'); await f.tick(7_500);
  assert.equal(f.timers.size, 0);
  f.bind('direct:333', parent.id); f.abort(); await flush();
  assert.equal(f.calls.length, 1);
});

test('local child activation is not busy when idle; external scoped runs settle on any outcome', async () => {
  const f = fixture(); const parent = f.add('parent'); const other = f.add('other');
  f.bind('group:111', parent.id); f.start();
  parent.ctx.emit('subagent/start', { runId: 'local', local: true });
  other.ctx.emit('subagent/start', { runId: 'foreign', local: false });
  await flush(); assert.equal(f.calls.length, 0);
  parent.ctx.emit('subagent/start', { runId: 'external', local: false });
  await flush(); assert.equal(f.calls.length, 1);
  parent.ctx.emit('subagent/end', { runId: 'external', local: false, stopReason: 'error' });
  assert.equal(f.timers.size, 0); f.abort();
});

test('failed and in-flight requests do not overlap; disposal clears jobs and listeners', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const f = fixture({ send: () => pending });
  const parent = f.add('parent', 'running'); f.bind('group:111', parent.id);
  f.start(); await flush(); await f.tick(22_500);
  assert.equal(f.calls.length, 1);
  release(); await flush(); assert.equal(f.calls.length, 2); // overdue heartbeat resumes immediately
  await f.tick(7_500); assert.equal(f.calls.length, 3);
  f.remove(parent); assert.equal(parent.ctx.count(), 0); assert.equal(f.timers.size, 0);
  f.abort(); assert.equal(f.listenerCount(), 0);
  const failing = fixture({ send: () => Promise.reject(new Error('secret')) });
  const a = failing.add('a', 'running'); failing.bind('group:111', a.id); failing.start();
  await flush(); await failing.tick(7_500); assert.equal(failing.calls.length, 2);
  failing.abort();
});

test('plugin effect cleanup is idempotent and unsupported lifecycle fails closed', async () => {
  const f = fixture(); const a = f.add('a', 'running'); f.bind('direct:111', a.id);
  const close = f.start(); f.effects.forEach((dispose) => dispose()); close();
  await flush(); assert.equal(f.calls.length, 0); assert.equal(f.listenerCount(), 0);
  assert.equal(observeDiscordActivity({ get: () => undefined }, { sendTyping() { assert.fail(); } }), null);
});

test('a nested active child reaches its bound intermediate parent and root channels', async () => {
  const f = fixture(); const root = f.add('root'); const middle = f.add('middle', 'idle', root);
  f.add('leaf', 'running', middle);
  f.bind('group:111', root.id); f.bind('group:222', middle.id);
  f.start(); await flush();
  assert.deepEqual(f.calls.map((c) => c.channelId).sort(), ['111', '222']);
  f.abort();
});

test('missing or broken optional services do not invent activity', async () => {
  assert.equal(observeDiscordActivity({ get() { throw new Error('unavailable'); } }), null);
  const f = fixture(); const a = f.add('a'); f.bind('group:111', a.id);
  const get = f.ctx.get; f.ctx.get = (name) => name === 'jobs' ? undefined : get(name);
  f.start(); await flush(); assert.equal(f.calls.length, 0); f.abort();
});

test('a later lifecycle read failure cannot reject agent creation and cleans subscriptions', async () => {
  const f = fixture(); f.start();
  const jobs = f.ctx.get('jobs'); jobs.list = () => { throw new Error('unavailable'); };
  assert.doesNotThrow(() => f.add('later'));
  assert.equal(f.stops(), 1);
  assert.equal(f.listenerCount(), 0); assert.equal(f.timers.size, 0);
});

test('Discord runtime owns observer lifetime across start and stop without sending messages', async () => {
  const listeners = new Map(); let seen; let closes = 0;
  const socket = {
    readyState: 1,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    emit(name, value) { for (const fn of listeners.get(name) ?? []) fn(value); },
    send(value) {
      if (JSON.parse(value).op === 2) queueMicrotask(() => socket.emit('message', {
        data: JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 's' } }),
      }));
    },
    close() { socket.readyState = 3; socket.emit('close', { code: 1000 }); },
  };
  const runtime = new DiscordRuntime({
    config: { botId: 'test', platformId: '123' }, token: 'test',
    harness: { ensureRunning: async () => true }, state: {},
    createApi: () => ({ getCurrentUser: async () => ({ id: '123', bot: true }),
      getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }) }),
    createWebSocket: () => { queueMicrotask(() => socket.emit('message', {
      data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }),
    })); return socket; },
    observeActivity(options) { seen = options; return () => { closes++; }; },
    logger: { warn() {}, error() {} }, random: () => 0.5,
  });
  await runtime.start(); assert.ok(seen); assert.equal(seen.signal.aborted, false);
  await runtime.stop(); assert.equal(closes, 1); assert.equal(seen.signal.aborted, true);
});

test('legacy and activity typing are additive with shared rate cap and bounded requests', async () => {
  const calls = []; const abort = new AbortController(); let time = 0;
  const client = new DiscordBotClient({ api: { sendTyping: async (value) => calls.push(value) }, signal: abort.signal, now: () => time });
  client.activityTyping = true; // an old caller cannot suppress the legacy path
  await client.sendTyping({ channelId: '111' }); assert.equal(calls.length, 1);
  await client.sendActivityTyping({ channelId: '111' }); assert.equal(calls.length, 1);
  time = 7500;
  await client.sendActivityTyping({ channelId: '111' }); assert.equal(calls.length, 2);
  await client.sendTyping({ channelId: '111' }); assert.equal(calls.length, 2);
  assert.ok(calls[0].signal instanceof AbortSignal);
  abort.abort(); assert.equal(calls[0].signal.aborted, true);
});

test('activity reschedules from the transport clock after a legacy pulse wins', async () => {
  let first = true;
  const f = fixture({ send: () => {
    if (first) { first = false; return { sent: false, lastPulseAt: -1000 }; }
  } });
  const a = f.add('parent', 'running'); f.bind('group:111', a.id); f.start(); await flush();
  await f.tick(6499); assert.equal(f.calls.length, 1);
  await f.tick(1); assert.equal(f.calls.length, 2); f.abort();
});

test('foreground and goal continuation turns hydrate and stop without children', async () => {
  const f = fixture(); const a = f.add('parent', 'running'); f.bind('group:111', a.id);
  f.start(); await flush(); assert.equal(f.calls.length, 1);
  f.status(a, 'idle'); await f.tick(7500); assert.equal(f.calls.length, 1);
  f.status(a, 'running'); await flush(); assert.equal(f.calls.length, 2);
  f.abort();
});

test('external live activations hydrate across observer restart, settle, and reject stale parent identity', async () => {
  const f = fixture(); const a = f.add('parent'); f.bind('group:111', a.id);
  const resident = new Map([['external', { kind: 'external', childId: 'external', parent: a }],
    ['foreign', { kind: 'external', childId: 'foreign', parent: { id: a.id } }]]);
  const get = f.ctx.get; f.ctx.get = (name) => name === 'subagents' ? { manager: { resident } } : get(name);
  const close = f.start(); await flush(); assert.equal(f.calls.length, 1);
  close(); f.start(); await flush(); assert.equal(f.calls.length, 2);
  resident.delete('external');
  a.ctx.emit('subagent/end', { id: 'external', local: false, runId: 'x' });
  await f.tick(15000); assert.equal(f.calls.length, 2); f.abort();
});

test('receiving no idle or job settlement event cannot keep an idle channel typing', async () => {
  const f = fixture();
  const a = f.add('foreground', 'running');
  const b = f.add('background');
  f.bind('group:111', a.id);
  f.bind('group:222', b.id);
  f.job('job', b.id, 'running');
  f.start();
  await flush();
  assert.equal(f.calls.length, 2);
  a.status = 'idle';
  f.jobRows.get('job').status = 'completed';
  await f.tick(15_000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.timers.size, 0);
  f.abort();
});

test('modern resident activations follow verified ancestors and retire without an external end event', async () => {
  const f = fixture();
  const root = f.add('root');
  const middle = f.add('middle');
  const leaf = f.add('leaf', 'running');
  const agents = f.ctx.get('agents');
  delete agents.isOwnedBy;
  const resident = new Map([
    ['middle', { kind: 'local', childId: middle.id, root, ancestors: [root.id], handle: { agent: middle } }],
    ['leaf', { kind: 'local', childId: leaf.id, root, ancestors: [root.id, middle.id], handle: { agent: leaf } }],
  ]);
  const get = f.ctx.get;
  f.ctx.get = name => name === 'subagents' ? { manager: { resident } } : get(name);
  f.bind('group:111', root.id);
  f.bind('group:222', middle.id);
  f.start();
  await flush();
  assert.deepEqual(f.calls.map(c => c.channelId).sort(), ['111', '222']);
  f.status(leaf, 'idle');
  assert.equal(f.timers.size, 0);

  resident.set('external', { kind: 'external', childId: 'external', root, ancestors: [root.id, middle.id] });
  root.ctx.emit('subagent/start', { runId: 'external-run', id: 'external', parentSessionId: middle.id, local: false });
  await f.tick(450_000);
  assert.equal(f.calls.length, 2 * 61);
  assert.deepEqual(f.calls.slice(-2).map(c => c.channelId).sort(), ['111', '222']);
  resident.delete('external');
  await f.tick(15_000);
  assert.equal(f.calls.length, 2 * 61);
  assert.equal(f.timers.size, 0);
  f.abort();
});

test('public ownership and root-carried events preserve the direct parent when the activation map is unavailable', async () => {
  const f = fixture();
  const root = f.add('root');
  const middle = f.add('middle', 'running');
  const agents = f.ctx.get('agents');
  delete agents.isOwnedBy;
  const get = f.ctx.get;
  f.ctx.get = name => name === 'subagents'
    ? { rootOf: agent => agent === middle ? root : agent } : get(name);
  f.bind('group:111', root.id);
  f.bind('group:222', middle.id);
  f.start();
  await flush();
  assert.equal(f.calls.length, 2);
  f.status(middle, 'idle');
  assert.equal(f.timers.size, 0);
  const external = { runId: 'external-run', id: 'external', parentSessionId: middle.id, local: false };
  root.ctx.emit('subagent/start', external);
  await f.tick(7_500);
  assert.deepEqual(f.calls.slice(2).map(c => c.channelId).sort(), ['111', '222']);
  root.ctx.emit('subagent/end', external);
  assert.equal(f.timers.size, 0);
  f.abort();
});

test('an activation from a replaced Agent identity does not keep its replacement typing', async () => {
  const f = fixture();
  const old = f.add('root');
  const resident = new Map([
    ['external', { kind: 'external', childId: 'external', root: old, ancestors: [old.id] }],
  ]);
  const get = f.ctx.get;
  f.ctx.get = name => name === 'subagents' ? { manager: { resident } } : get(name);
  f.bind('group:111', old.id);
  f.start();
  await flush();
  assert.equal(f.calls.length, 1);
  f.add(old.id);
  assert.equal(old.ctx.count(), 0);
  await f.tick(15_000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
  f.abort();
});

test('diagnostics report attachment, busy route, errors and stop without content', async () => {
  const f = fixture({ send: () => Promise.reject(new Error('private contents')) });
  const a = f.add('parent', 'running'); f.bind('group:111', a.id);
  const snapshots = []; f.diagnostics = (value) => snapshots.push(value);
  f.start(); await flush();
  assert.equal(snapshots.at(-1).attached, true);
  assert.deepEqual(snapshots.at(-1).channels, ['111']);
  assert.ok(snapshots.at(-1).busySessions.includes(a.id));
  assert.ok(snapshots.at(-1).errors.includes('typing-send-failed'));
  assert.deepEqual(snapshots.at(-1).lastFailure, { at: 0, channelId: '111', kind: 'unknown' });
  assert.ok(!JSON.stringify(snapshots).includes('private contents'));
  f.abort(); assert.equal(snapshots.at(-1).attached, false);
  const missing = [];
  assert.equal(observeDiscordActivity({ get: () => undefined }, { diagnostics: (v) => missing.push(v) }), null);
  assert.equal(missing[0].reason, 'missing-agents');
});

test('typing diagnostic reports safe rate-limit data and follows the shared cooldown', async () => {
  const status = Object.assign(new Error('private contents'), { status: 429, providerCode: 20028, retryAfter: 30 });
  let count = 0;
  const f = fixture({ send: () => {
    if (++count === 1) throw status;
    if (count === 2) return { sent: false, lastPulseAt: 29_000, nextPulseAt: 65_000 };
  } });
  const a = f.add('parent', 'running');
  f.bind('group:111', a.id);
  let diagnostic;
  f.diagnostics = value => { diagnostic = value; };
  f.start();
  await flush();
  assert.deepEqual(diagnostic.lastFailure,
    { at: 0, channelId: '111', kind: 'http', status: 429, providerCode: 20028, retryAfterMs: 30_000 });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private contents/u);
  await f.tick(29_999);
  assert.equal(f.calls.length, 1);
  await f.tick(1);
  assert.equal(f.calls.length, 2);
  await f.tick(35_000);
  assert.deepEqual(f.calls.map(call => call.at), [0, 30_000, 65_000]);
  f.abort();
});

test('long Discord cooldowns cap the timer and a late shutdown error is ignored', async () => {
  const f = fixture({ send: () => ({ sent: false, lastPulseAt: 0, nextPulseAt: Number.MAX_SAFE_INTEGER }) });
  const a = f.add('parent', 'running');
  f.bind('group:111', a.id);
  f.start();
  await flush();
  assert.equal([...f.timers.values()][0].at, 2 ** 31 - 1);
  await f.tick(2 ** 31 - 1);
  assert.equal(f.calls.length, 1);
  assert.equal([...f.timers.values()][0].at, 2 * (2 ** 31 - 1));
  f.abort();

  let reject;
  const shutdown = fixture({ send: () => new Promise((_resolve, fail) => { reject = fail; }) });
  shutdown.bind('direct:222', shutdown.add('b', 'running').id);
  let diagnostic;
  shutdown.diagnostics = value => { diagnostic = value; };
  shutdown.start();
  await flush();
  shutdown.abort();
  reject(new Error('late shutdown error'));
  await flush();
  assert.equal(diagnostic.lastFailure, null);
  assert.deepEqual(diagnostic.errors, []);
});

test('malformed external manager degrades coverage without disabling foreground', async () => {
  const f = fixture(); const a = f.add('parent', 'running'); f.bind('group:111', a.id);
  const get = f.ctx.get; f.ctx.get = (name) => name === 'subagents'
    ? { manager: { resident: new Map([['bad', {}]]) } } : get(name);
  let diagnostic; f.diagnostics = (value) => { diagnostic = value; };
  f.start(); await flush(); assert.equal(f.calls.length, 1);
  assert.equal(diagnostic.externalCoverage, 'unavailable(activation-shape)');
  assert.equal(diagnostic.attached, true); f.abort();
});

test('diagnostic writer coalesces to latest bounded snapshot on disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'typing-diagnostic-'));
  const path = join(directory, 'discord-typing.json');
  try {
    const publish = createTypingDiagnostics(path);
    for (let i = 0; i < 100; i++) publish({ at: i, attached: true });
    await new Promise((resolve, reject) => {
      let attempts = 0;
      const check = async () => {
        try { if (JSON.parse(await readFile(path, 'utf8')).at === 99) return resolve(); } catch {}
        if (++attempts > 100) return reject(new Error('snapshot not written'));
        setTimeout(check, 10);
      }; void check();
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
