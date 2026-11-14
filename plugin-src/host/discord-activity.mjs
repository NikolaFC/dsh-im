import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

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
  const records = new Map(), lastPulse = new Map(), inFlight = new Set();
  const disposers = [], errors = [];
  let agents, jobs, subagents, timer = null, closed = false, attached = false;
  let reason = 'starting', externalCoverage = 'unavailable(missing-service)';
  let busySessions = [], activeChannels = [];
  const report = () => {
    try { diagnostics?.({ at: now(), pid: process.pid, attached, reason, externalCoverage,
      busySessions: busySessions.slice(0, 500), channels: activeChannels.slice(0, 500),
      lastPulseAtByChannel: Object.fromEntries([...lastPulse].slice(-500)), errors: [...errors] }); } catch {}
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

  // Compatibility seam for the installed runtime: its public catalog's activity
  // uses Session residency, but external activations have no local Session.
  // Never infer liveness from durable catalog/history. Unknown shapes fail soft.
  const liveExternal = () => {
    const owners = new Set();
    try {
      const resident = subagents?.manager?.resident;
      if (!(resident instanceof Map)) { externalCoverage = 'unavailable(manager-resident)'; return owners; }
      for (const [id, row] of resident) {
        if (!row || !['local', 'external'].includes(row.kind) || row.childId !== id || !row.parent?.id) {
          externalCoverage = 'unavailable(activation-shape)'; return new Set();
        }
        if (row.kind === 'external' && agents.get(row.parent.id) === row.parent) owners.add(row.parent.id);
      }
      externalCoverage = 'live-manager';
    } catch { externalCoverage = 'unavailable(read-failed)'; return new Set(); }
    return owners;
  };
  const channels = () => {
    const busy = new Set(), externalOwners = liveExternal();
    for (const [id, record] of records) {
      if (!record.running && !record.jobs.size && !record.external.size && !externalOwners.has(id)) continue;
      let current = id;
      const visited = new Set();
      while (current && !visited.has(current)) {
        visited.add(current); busy.add(current); current = records.get(current)?.parent;
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
  const pulse = (channelId) => {
    if (closed || signal?.aborted || inFlight.has(channelId)) return;
    if (now() - (lastPulse.get(channelId) ?? -Infinity) < 7_500) return;
    lastPulse.set(channelId, now()); inFlight.add(channelId);
    Promise.resolve().then(() => {
      if (!closed && !signal?.aborted && channels().has(channelId)) return sendTyping({ channelId });
    }).then((result) => {
      // A legacy pulse may have preceded this timer: align to the real shared
      // transport clock instead of waiting another full 7.5s after a skip.
      if (Number.isFinite(result?.lastPulseAt)) lastPulse.set(channelId, result.lastPulseAt);
    }).catch(() => error('typing-send-failed')).finally(() => {
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
    for (const [id, at] of lastPulse) if (!next.has(id) && now() - at >= 7_500) lastPulse.delete(id);
    if (next.size) {
      const delay = Math.min(...[...next].map((id) => inFlight.has(id) ? 7_500 : Math.max(1, 7_500 - (now() - lastPulse.get(id)))));
      timer = schedule(safely(() => { timer = null; reconcile(); }), delay); timer?.unref?.();
    }
    report();
  };
  const linkParents = () => {
    for (const record of records.values()) {
      record.parent = null;
      if (typeof agents.isOwnedBy !== 'function') { error('missing-agents.isOwnedBy'); continue; }
      for (const candidate of records.values()) if (candidate !== record && agents.isOwnedBy(record.agent.id, candidate.agent)) {
        record.parent = candidate.agent.id; break;
      }
    }
  };
  const attach = (agent) => {
    if (closed || records.get(agent.id)?.agent === agent) return;
    detach(agent.id);
    const record = { agent, running: agent.status === 'running', parent: null, jobs: new Set(), external: new Set(), dispose: [] };
    records.set(agent.id, record);
    if (jobs?.events?.subscribe && typeof jobs.list === 'function') {
      record.dispose.push(jobs.events.subscribe({ owner: agent.id }, safely((event) => {
        if (records.get(agent.id) !== record || !event.job || event.job.owner !== agent.id) return;
        const job = event.job;
        if (event.type !== 'removed' && ['running', 'stopping'].includes(job.status)) record.jobs.add(job.id);
        else record.jobs.delete(job.id);
        reconcile();
      })));
      for (const job of jobs.list(agent.id)) if (job.owner === agent.id && ['running', 'stopping'].includes(job.status)) record.jobs.add(job.id);
    }
    if (agent.ctx?.on) {
      record.dispose.push(agent.ctx.on('subagent/start', safely((info) => {
        if (info.local !== false || records.get(agent.id) !== record) return;
        record.external.add(info.runId); reconcile();
      })));
      record.dispose.push(agent.ctx.on('subagent/end', safely((info) => { record.external.delete(info.runId); reconcile(); })));
    }
    linkParents(); reconcile();
  };
  if (signal?.aborted) return unavailable('aborted');
  try {
    disposers.push(ctx.on('agent/created', safely(({ agent }) => { attach(agent); })));
    disposers.push(ctx.on('agent/status', safely(({ agent, status }) => {
      if (!records.has(agent.id)) attach(agent);
      const record = records.get(agent.id);
      if (record?.agent !== agent) return;
      record.running = status === 'running'; reconcile();
    })));
    disposers.push(ctx.on('agent/disposed', safely(({ agent }) => {
      if (records.get(agent.id)?.agent !== agent) return;
      detach(agent.id); linkParents(); reconcile();
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
