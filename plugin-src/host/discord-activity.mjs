import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { classifyDiscordTypingError } from '../../src/channels/discord/typing-error.mjs';

const PULSE_INTERVAL = 7_500;
const MAX_TIMER_DELAY = 2 ** 31 - 1;

// The subagent service publishes lifecycle edges on the tree root in newer
// hosts. The running activation map is the source for hydrated membership and
// external runs, which have no Agent of their own.
function readActivations(subagents, agents) {
  try {
    const resident = subagents?.manager?.resident;
    if (!(resident instanceof Map)) return { coverage: 'unavailable(manager-resident)' };
    const owners = new Map(), external = new Set();
    for (const [id, row] of resident) {
      if (!row || !['local', 'external'].includes(row.kind) || row.childId !== id) {
        return { coverage: 'unavailable(activation-shape)' };
      }
      if (row.root?.id && Array.isArray(row.ancestors)) {
        if (row.ancestors[0] !== row.root.id
          || row.ancestors.some(ancestor => typeof ancestor !== 'string' || !ancestor || ancestor === id)
          || new Set(row.ancestors).size !== row.ancestors.length
          || (row.kind === 'local' && row.handle?.agent?.id !== id)) {
          return { coverage: 'unavailable(activation-shape)' };
        }
        if (agents.get(row.root.id) !== row.root) continue;
        const liveAncestors = row.ancestors.filter(ancestor => {
          if (ancestor === row.root.id) return true;
          const parent = resident.get(ancestor);
          return parent?.kind === 'local' && parent.root === row.root
            && parent.handle?.agent && agents.get(ancestor) === parent.handle.agent;
        });
        if (row.kind === 'external') for (const ancestor of liveAncestors) external.add(ancestor);
        else if (agents.get(id) === row.handle.agent) owners.set(id, liveAncestors);
      } else if (row.parent?.id) {
        if (agents.get(row.parent.id) !== row.parent) continue;
        if (row.kind === 'external') external.add(row.parent.id);
      } else {
        return { coverage: 'unavailable(activation-shape)' };
      }
    }
    return { coverage: 'live-manager', owners, external };
  } catch {
    return { coverage: 'unavailable(read-failed)' };
  }
}

// One coalesced, atomic snapshot, never an unbounded queue/log. No task content.
export function createTypingDiagnostics(path, logger = console) {
  let latest, writing = false;
  return (snapshot) => {
    latest = snapshot;
    if (writing) return;
    writing = true;
    void (async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        while (latest) {
          const value = latest; latest = undefined;
          await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
          await rename(`${path}.tmp`, path);
        }
      } catch { latest = undefined; try { logger.warn?.('[dsh-im:discord] typing diagnostics write failed'); } catch {} }
      finally { writing = false; }
    })();
  };
}

export function observeDiscordActivity(ctx, {
  state, sendTyping, signal, onStop, logger = console, diagnostics,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: unschedule = globalThis.clearTimeout,
  now = Date.now,
} = {}) {
  const records = new Map(), lastPulse = new Map(), retryNotBefore = new Map(), inFlight = new Set();
  const disposers = [], errors = [];
  let agents, jobs, subagents, timer = null, closed = false, attached = false;
  let reason = 'starting', externalCoverage = 'unavailable(missing-service)';
  let busySessions = [], activeChannels = [], lastFailure = null;
  const report = () => {
    try { diagnostics?.({ at: now(), pid: process.pid, attached, reason, externalCoverage,
      busySessions: busySessions.slice(0, 500), channels: activeChannels.slice(0, 500),
      lastPulseAtByChannel: Object.fromEntries([...lastPulse].slice(-500)), errors: [...errors],
      lastFailure }); } catch {}
  };
  const error = (code) => {
    if (errors.at(-1) !== code) errors.push(code);
    if (errors.length > 16) errors.shift();
    try { logger.warn?.(`[dsh-im:discord] ${code}`); } catch {}
    report();
  };
  const unavailable = (why) => { reason = why; report(); return null; };
  try { agents = ctx?.get?.('agents'); jobs = ctx?.get?.('jobs'); subagents = ctx?.get?.('subagents'); }
  catch { return unavailable('service-read-failed'); }
  if (!agents?.list || !agents?.get) return unavailable('missing-agents');
  if (!ctx?.on) return unavailable('missing-events');
  if (!state?.snapshot || !state?.sessionFor) return unavailable('missing-state');
  if (typeof sendTyping !== 'function') return unavailable('missing-transport');

  const parentsOf = (agent, owners, live) => {
    if (owners?.has(agent.id)) return owners.get(agent.id);
    if (typeof subagents?.rootOf === 'function') {
      try {
        const root = subagents.rootOf(agent);
        if (root && root !== agent && live.get(root.id) === root) return [root.id];
      } catch { /* Ordinary work survives unavailable subagent ownership. */ }
    }
    if (typeof agents.isOwnedBy === 'function') {
      for (const candidate of live.values()) {
        if (candidate !== agent && agents.isOwnedBy(agent.id, candidate)) return [candidate.id];
      }
    }
    return [];
  };
  const channels = () => {
    const activations = readActivations(subagents, agents);
    externalCoverage = activations.coverage;
    const busy = new Set(), live = new Map();
    for (const [id, record] of records) {
      if (agents.get(id) === record.agent) live.set(id, record.agent);
      if (activations.external) record.external.clear();
    }
    const markBusy = (id) => {
      const agent = live.get(id);
      if (!agent || busy.has(id)) return;
      busy.add(id);
      for (const parent of parentsOf(agent, activations.owners, live)) markBusy(parent);
    };
    for (const [id, agent] of live) {
      const hasJobs = typeof jobs?.list === 'function' && jobs.list(id)
        .some(job => job.owner === id && ['running', 'stopping'].includes(job.status));
      if (agent.status === 'running' || hasJobs || activations.external?.has(id)) markBusy(id);
      if (!activations.external) {
        for (const parent of records.get(id).external.values()) {
          if (live.get(parent.id) === parent) { markBusy(parent.id); markBusy(id); }
        }
      }
    }
    const result = new Set();
    for (const [key, id] of Object.entries(state.snapshot()?.sessions ?? {})) {
      const match = /^(?:direct|group):(\d+)$/.exec(key);
      if (match && busy.has(id) && state.sessionFor(key) === id) result.add(match[1]);
    }
    busySessions = [...busy]; activeChannels = [...result];
    return result;
  };
  const stopTimer = () => { if (timer !== null) unschedule(timer); timer = null; };
  const detach = (id) => {
    const record = records.get(id); if (!record) return;
    records.delete(id);
    for (const dispose of record.dispose) { try { dispose?.(); } catch { error('cleanup-failed'); } }
  };
  const close = (why = 'closed') => {
    if (closed) return;
    closed = true; attached = false; reason = typeof why === 'string' ? why : 'aborted';
    stopTimer(); signal?.removeEventListener('abort', close);
    for (const dispose of disposers) { try { dispose?.(); } catch { error('cleanup-failed'); } }
    for (const id of [...records.keys()]) detach(id);
    busySessions = []; activeChannels = []; report();
    try { onStop?.(); } catch {}
  };
  const safely = (callback) => (...args) => {
    if (closed) return;
    try { callback(...args); } catch { error('lifecycle-error'); close('lifecycle-error'); }
  };
  const nextPulse = channelId => Math.max(
    (lastPulse.get(channelId) ?? -Infinity) + PULSE_INTERVAL,
    retryNotBefore.get(channelId) ?? -Infinity,
  );
  const pulse = (channelId) => {
    if (closed || signal?.aborted || inFlight.has(channelId)) return;
    if (now() < nextPulse(channelId)) return;
    lastPulse.set(channelId, now()); inFlight.add(channelId);
    Promise.resolve().then(() => {
      if (!closed && !signal?.aborted && channels().has(channelId)) return sendTyping({ channelId });
    }).then((result) => {
      // A legacy pulse may have preceded this timer: align to the real shared
      // transport clock instead of waiting another full 7.5s after a skip.
      if (Number.isFinite(result?.lastPulseAt)) lastPulse.set(channelId, result.lastPulseAt);
      if (Number.isFinite(result?.nextPulseAt)) retryNotBefore.set(channelId, result.nextPulseAt);
    }).catch((cause) => {
      if (closed || signal?.aborted) return;
      const failure = classifyDiscordTypingError(cause);
      if (failure.kind === 'abort') return;
      const at = now();
      if (Number.isFinite(failure.retryAfterMs)) {
        retryNotBefore.set(channelId, Math.min(Number.MAX_SAFE_INTEGER, at + failure.retryAfterMs));
      }
      lastFailure = { at, channelId, ...failure };
      error('typing-send-failed');
    }).finally(() => {
      inFlight.delete(channelId);
      if (!closed) safely(reconcile)(); else report();
    });
  };
  const reconcile = () => {
    if (closed) return;
    const next = channels();
    for (const id of next) pulse(id);
    stopTimer();
    // Prune retired channel timestamps; the transport owns cross-producer dedupe.
    const at = now();
    for (const [id, until] of retryNotBefore) if (until <= at) retryNotBefore.delete(id);
    for (const [id, pulseAt] of lastPulse) if (!next.has(id) && at - pulseAt >= PULSE_INTERVAL) lastPulse.delete(id);
    if (next.size) {
      const delay = Math.min(MAX_TIMER_DELAY, ...[...next].map((id) => inFlight.has(id)
        ? PULSE_INTERVAL : Math.max(1, nextPulse(id) - at)));
      timer = schedule(safely(() => { timer = null; reconcile(); }), delay); timer?.unref?.();
    }
    report();
  };
  const attach = (agent) => {
    if (closed || records.get(agent.id)?.agent === agent) return;
    detach(agent.id);
    const record = { agent, external: new Map(), dispose: [] };
    records.set(agent.id, record);
    if (jobs?.events?.subscribe && typeof jobs.list === 'function') {
      record.dispose.push(jobs.events.subscribe({ owner: agent.id }, safely((event) => {
        if (records.get(agent.id) !== record || !event.job || event.job.owner !== agent.id) return;
        reconcile();
      })));
    }
    if (agent.ctx?.on) {
      record.dispose.push(agent.ctx.on('subagent/start', safely((info) => {
        if (info.local !== false || records.get(agent.id) !== record || agents.get(agent.id) !== agent) return;
        const parent = info.parentSessionId === undefined ? agent : agents.get(info.parentSessionId);
        if (typeof info.runId === 'string' && parent) record.external.set(info.runId, parent);
        reconcile();
      })));
      record.dispose.push(agent.ctx.on('subagent/end', safely((info) => { record.external.delete(info.runId); reconcile(); })));
    }
    reconcile();
  };
  if (signal?.aborted) return unavailable('aborted');
  try {
    disposers.push(ctx.on('agent/created', safely(({ agent }) => { attach(agent); })));
    disposers.push(ctx.on('agent/status', safely(({ agent }) => {
      if (agents.get(agent.id) !== agent) return;
      if (records.get(agent.id)?.agent !== agent) attach(agent);
      else reconcile();
    })));
    disposers.push(ctx.on('agent/disposed', safely(({ agent }) => {
      if (records.get(agent.id)?.agent !== agent) return;
      detach(agent.id); reconcile();
    })));
    for (const event of ['dsh-im/session-pre-bind', 'dsh-im/session-unbind']) disposers.push(ctx.on(event, safely(reconcile)));
    for (const agent of agents.list()) attach(agent);
    if (closed) return null;
    signal?.addEventListener('abort', close, { once: true });
    ctx.effect?.(() => close);
    if (closed) return null;
    attached = true; reason = 'observing'; reconcile();
    return close;
  } catch { error('attach-failed'); close('attach-failed'); return null; }
}
