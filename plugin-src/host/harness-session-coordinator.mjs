import { randomUUID } from 'node:crypto';

import {
  InboundFileError,
  stageInboundFiles,
} from '../../src/channels/shared/inbound-file.mjs';
import { hasPendingHarnessQuestion } from './modern-harness-api.mjs';

function agentsFromContext(ctx) {
  if (typeof ctx?.get !== 'function') return undefined;
  let agents;
  try {
    agents = ctx.get('agents');
  } catch {
    return undefined;
  }
  if (agents === undefined || agents === null) return undefined;
  if (typeof agents.get !== 'function') {
    throw new TypeError('dsh-im requires a callable AgentRegistry when ctx.get("agents") is present');
  }
  return agents;
}

function currentOwnedTurn(agent, expectedTurn, promptRpcId) {
  if (agent?.status !== 'running') return false;
  const events = typeof agent?.session?.snapshotEvents === 'function'
    ? agent.session.snapshotEvents()
    : agent?.session?.events;
  if (!Array.isArray(events)) return false;

  let openTurn = null;
  let owned = false;
  for (const event of events) {
    if (event?.type === 'turn/start') {
      openTurn = event.data?.turn ?? null;
      owned = false;
      continue;
    }
    if (event?.type === 'turn/end' && event.data?.turn === openTurn) {
      openTurn = null;
      owned = false;
      continue;
    }
    if (openTurn === expectedTurn
      && event?.type === 'user/message'
      && event.data?.source?.rpcId === promptRpcId) {
      owned = true;
    }
  }
  return openTurn === expectedTurn && owned;
}

// A retained route credential may steer only an uninterrupted sequence of
// goal-driver turns following its exact prompt. Ordinary/manual turns break
// the chain. Inspect and inject in the same tick; no history-read race or wake.
function currentGoalContinuation(agent, anchorTurn, promptRpcId) {
  if (agent?.status !== 'running' || !Number.isSafeInteger(anchorTurn)) return false;
  const events = typeof agent?.session?.snapshotEvents === 'function'
    ? agent.session.snapshotEvents() : agent?.session?.events;
  if (!Array.isArray(events)) return false;
  let turn = null;
  let anchored = false;
  let firstInput = false;
  let goalTurn = false;
  let goalId = null;
  for (const event of events) {
    if (event?.type === 'turn/start') {
      // An unclosed or input-less continuation is not proven lineage.
      if (anchored && turn !== null) return false;
      turn = event.data?.turn ?? null;
      firstInput = false;
      goalTurn = false;
    } else if (event?.type === 'user/message') {
      const source = event.data?.source;
      // Host-authored context shares the event type with inbox messages.
      if (['runtime-context', 'time-context', 'model-selection', 'plugin:dsh-im'].includes(source?.kind)
        && ['snapshot', 'notice'].includes(source?.form)) continue;
      if (source?.kind === 'skill-catalog' && source?.form === 'catalog') continue;
      if (turn === anchorTurn && source?.rpcId === promptRpcId) anchored = true;
      if (anchored && turn !== anchorTurn && !firstInput) {
        if (source?.kind !== 'goal' || typeof source.goalId !== 'string' || !source.goalId
          || (goalId !== null && goalId !== source.goalId)) return false;
        goalId = source.goalId;
        goalTurn = true;
      }
      firstInput = true;
    } else if (event?.type === 'turn/end' && event.data?.turn === turn) {
      if (anchored) {
        const reason = event.data?.reason?.kind ?? event.data?.reason;
        if (reason && reason !== 'completed') return false;
        if (turn !== anchorTurn && !goalTurn) return false;
      }
      turn = null;
      goalTurn = false;
    }
  }
  return anchored && turn !== null && turn > anchorTurn && goalTurn;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function steeringMessage(text, rpcId) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId },
  });
}

function agentBusyError(cause) {
  const error = new Error('Session is busy with an active turn or maintenance task', { cause });
  error.code = 'agent-busy';
  return error;
}

function currentOpenTurn(agent) {
  if (agent?.status !== 'running') return false;
  const events = typeof agent.session?.snapshotEvents === 'function'
    ? agent.session.snapshotEvents() : agent.session?.events;
  if (!Array.isArray(events)) return false;
  let turn = null;
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data?.turn ?? null;
    if (event.type === 'turn/end' && event.data?.turn === turn) turn = null;
  }
  return turn !== null;
}

function createControlExecutor(agents, ctx) {
  return ({ sessionId, expectedTurn, promptRpcId, continuationAfterTurn, boundSession, inputRpcId, action, text }) => {
    const agent = agents.get(sessionId);
    // An unattached Session cannot be coordinated in-process. Let the client
    // retain its legacy HTTP path for deployments where attachment is lazy.
    if (boundSession !== undefined) {
      if (typeof boundSession !== 'function' || boundSession(sessionId) !== true) return false;
      if (!agent || agents.get(sessionId) !== agent || !currentOpenTurn(agent)) return false;
    } else if (!agent) return undefined;
    else if (continuationAfterTurn !== undefined) {
      if (action !== 'steer' || !currentGoalContinuation(agent, continuationAfterTurn, promptRpcId)) return false;
    } else if (!currentOwnedTurn(agent, expectedTurn, promptRpcId)) return false;

    if (action === 'stop') {
      agent.cancel({ kind: 'user' }, { keepInbox: true });
      return true;
    }
    if (action === 'steer') {
      if (typeof text !== 'string' || !text.trim()
        || typeof inputRpcId !== 'string' || !inputRpcId) return false;
      // ReactLoopAgent in DSH 0.2.2 still reports running during cancellation
      // unwind. When this runtime shape is available, honor its turn signal.
      const phase = agent.phase;
      if (phase?.kind === 'running' && phase.abort?.signal?.aborted === true) return false;
      if (hasPendingHarnessQuestion(ctx, sessionId)) throw Object.assign(
        new Error('The Harness turn is waiting for a question answer'),
        { code: 'harness-question-pending' },
      );
      // inject() never wakes an idle driver. Because validation and injection
      // share one JS tick, this context can only target this live turn's next step.
      agent.inject(steeringMessage(text, inputRpcId));
      return true;
    }
    throw new TypeError(`Unsupported Harness control action: ${String(action)}`);
  };
}

function createSessionMaintenanceExecutor(agents) {
  return ({ sessionId, operation }) => {
    if (typeof operation !== 'function') throw new TypeError('maintenance operation is required');
    const agent = agents.get(sessionId);
    if (!agent) return operation();
    try {
      // runMaintenance claims the true-idle phase synchronously. A prompt or a
      // second maintenance operation therefore cannot interleave with the RPC.
      return agent.runMaintenance((signal) => {
        if (agents.get(sessionId) !== agent) {
          const error = new Error('Session agent changed before maintenance started');
          error.code = 'agent-unavailable';
          throw error;
        }
        return operation(signal);
      });
    } catch (error) {
      throw agentBusyError(error);
    }
  };
}

function createFileIngressExecutor(agents, { inboundTtlService } = {}) {
  return ({ sessionId, workspace, files, signal }) => {
    const agent = agents.get(sessionId);
    const attachedWorkspace = agent?.session?.header?.cwd;
    const exactWorkspace = typeof attachedWorkspace === 'string' && attachedWorkspace
      ? attachedWorkspace
      : workspace;
    if (typeof exactWorkspace !== 'string' || !exactWorkspace) {
      throw new InboundFileError(
        'inbound-file-workspace-unavailable',
        'The Harness Session workspace is unavailable for inbound files.',
      );
    }
    const staged = stageInboundFiles({ files }, {
      workspace: exactWorkspace,
      signal,
      ...(inboundTtlService ? { retention: inboundTtlService.stagingRetention() } : {}),
      // Registration at creation time closes the mid-staging sweep window;
      // trackStaged later re-registers idempotently and owns the release.
      ...(typeof inboundTtlService?.trackDirectory === 'function'
        ? { onStagedDirectory: (directory) => inboundTtlService.trackDirectory(directory) }
        : {}),
    });
    return inboundTtlService
      ? staged.then((result) => (result ? inboundTtlService.trackStaged(result) : result))
      : staged;
  };
}

/**
 * Build optional same-process Session executors. File ingress also works for
 * cold Sessions by using the authoritative cwd returned by session.list;
 * when an Agent is attached, its live Session header remains authoritative.
 */
export function createHarnessSessionExecutors(ctx, provided = {}) {
  const {
    controlExecutor, sessionMaintenanceExecutor, fileIngressExecutor, inboundTtlService,
  } = provided;
  if (controlExecutor !== undefined && typeof controlExecutor !== 'function') {
    throw new TypeError('controlExecutor must be a function');
  }
  if (sessionMaintenanceExecutor !== undefined
    && typeof sessionMaintenanceExecutor !== 'function') {
    throw new TypeError('sessionMaintenanceExecutor must be a function');
  }
  if (fileIngressExecutor !== undefined && typeof fileIngressExecutor !== 'function') {
    throw new TypeError('fileIngressExecutor must be a function');
  }
  if (inboundTtlService !== undefined
    && (typeof inboundTtlService?.stagingRetention !== 'function'
      || typeof inboundTtlService?.trackStaged !== 'function')) {
    throw new TypeError('inboundTtlService must expose stagingRetention() and trackStaged()');
  }

  const agents = controlExecutor && sessionMaintenanceExecutor && fileIngressExecutor
    ? undefined
    : agentsFromContext(ctx);
  return {
    controlExecutor: controlExecutor ?? (agents ? createControlExecutor(agents, ctx) : undefined),
    sessionMaintenanceExecutor: sessionMaintenanceExecutor
      ?? (agents ? createSessionMaintenanceExecutor(agents) : undefined),
    fileIngressExecutor: fileIngressExecutor
      ?? createFileIngressExecutor(agents ?? { get: () => undefined }, { inboundTtlService }),
  };
}
