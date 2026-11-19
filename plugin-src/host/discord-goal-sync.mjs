import {
  accumulateFinalAssistantText,
  AssistantTextAccumulator,
} from '../../src/channels/shared/harness-client.mjs';
import { waitForPendingDiscordGoalOutput } from '../../src/channels/shared/discord-goal-output.mjs';

function isChildInput(source) {
  return (source?.kind === 'agent-message' && source.form === 'relay')
    || (source?.kind === 'subagent-settled' && source.form === 'notice');
}

export function isDiscordGoalCandidate(source) {
  return source?.kind === 'goal' || isChildInput(source);
}

function isFraming(source) {
  return (['runtime-context', 'time-context', 'model-selection', 'plugin:dsh-im'].includes(source?.kind)
    && ['notice', 'snapshot'].includes(source.form))
    || (source?.kind === 'skill-catalog' && source.form === 'catalog');
}

function completed(event) {
  const reason = event.data?.reason;
  return (reason?.kind ?? reason) === 'completed';
}

function ownedGoalChange(event, route) {
  const goal = event.data?.goal;
  return goal?.id === route.goalId && goal.revision === route.revision
    && goal.phase === 'active';
}

function closesOwnedGoal(event, route) {
  const goal = event.data?.goal;
  return event.data?.operation === 'complete' && goal?.id === route.goalId
    && goal.phase === 'complete' && goal.revision === route.revision + 1;
}

/**
 * Use the parent Session's durable records to prove which children were
 * catalogued by the admitted Goal. A user input that opened its own turn
 * breaks descendant attribution. A known, authenticated steer leaves it intact.
 */
export function discordGoalTurn({ events, endEvent, route, isSteer = () => false }) {
  if (!Array.isArray(events) || !Number.isSafeInteger(endEvent?.seq)
    || !Number.isSafeInteger(route?.goalStartSeq)) return null;
  const children = new Set();
  const endSeq = endEvent.seq;
  let goalActive = false;
  let turn = null;
  for (const event of events) {
    if (!Number.isSafeInteger(event?.seq)) continue;
    if (event.seq < route.goalStartSeq) continue;
    if (event.seq > endSeq) break;
    switch (event.type) {
      case 'goal/change':
        if (event.seq === route.goalStartSeq) {
          if (!ownedGoalChange(event, route)) return null;
          goalActive = true;
        } else if (!ownedGoalChange(event, route)) {
          goalActive = false;
          children.clear();
          // A Goal may mark itself complete before its last assistant text.
          if (turn) {
            turn.completedGoal = turn.owned && !turn.blocked && closesOwnedGoal(event, route);
            if (!turn.completedGoal) turn.blocked = true;
          }
        }
        break;
      case 'turn/start':
        turn = {
          number: event.data?.turn,
          owned: false,
          completedGoal: false,
          blocked: !goalActive,
          children: new Set(),
          assistant: new AssistantTextAccumulator(),
        };
        break;
      case 'user/message': {
        if (!turn || event.surfaceOp !== 'append') break;
        const source = event.data?.source;
        if (isFraming(source) || isSteer(event)) break;
        // The native update_goal tool defers a wrap-up instruction after the
        // same turn completes its Goal. It is framing, not new ownership.
        if (turn.completedGoal && source?.kind === 'tool-goal' && source.form === 'notice') break;
        if (source?.kind === 'goal' && source.goalId === route.goalId
          && source.revision === route.revision && Number.isSafeInteger(source.round) && source.round > 0) {
          turn.owned = true;
        } else if (isChildInput(source) && children.has(source.senderSessionId)) {
          turn.owned = true;
        } else {
          turn.blocked = true;
          if (source?.kind === 'user' || source?.kind === 'goal') children.clear();
        }
        break;
      }
      case 'subagent/catalog': {
        const id = event.data?.childId;
        if (turn?.owned && !turn.blocked && typeof id === 'string' && id) turn.children.add(id);
        break;
      }
      case 'assistant/message':
      case 'assistant/chunk':
      case 'tool/call':
        if (event.seq > route.deliverySeqFloor && turn && turn.number === endEvent.data?.turn
          && (event.data?.turn === undefined || event.data.turn === turn.number)
          && (event.surfaceOp === undefined || event.surfaceOp === 'append')
          && event.data?.interrupted !== true) accumulateFinalAssistantText(turn.assistant, event);
        break;
      case 'turn/end': {
        if (!turn || !Number.isSafeInteger(turn.number) || turn.number !== event.data?.turn) break;
        const owned = turn.owned && !turn.blocked;
        if (event.seq === endSeq) {
          return owned ? { text: completed(event) ? turn.assistant.text : '' } : null;
        }
        if (owned && goalActive && completed(event)) {
          for (const id of turn.children) children.add(id);
        }
        turn = null;
        break;
      }
    }
  }
  return null;
}

function sessionEvents(session) {
  return typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events;
}

function isStillCurrent(events, route, endSeq) {
  if (!Array.isArray(events)) return false;
  let laterTurn = false;
  let terminalChange = false;
  for (const event of events) {
    if (event.seq <= endSeq) continue;
    if (event.type === 'turn/start') laterTurn = true;
    if (event.type !== 'goal/change') continue;
    if (!terminalChange && ownedGoalChange(event, route)) continue;
    const goal = event.data?.goal;
    const exhausted = event.data?.operation === 'block' && goal?.id === route.goalId
      && goal.revision === route.revision + 1 && goal.phase === 'blocked'
      && goal.blockedReason?.code === 'round-limit';
    // At idle, the native driver can persist the round limit just after a
    // completed turn. That terminal mutation still owns the sealed answer.
    if (laterTurn || terminalChange || !(exhausted || closesOwnedGoal(event, route))) return false;
    terminalChange = true;
  }
  return true;
}

async function waitForAdmission(sessionId) {
  const pending = waitForPendingDiscordGoalOutput(sessionId);
  if (!pending) return;
  let timeout;
  try {
    await Promise.race([pending, new Promise(resolve => {
      timeout = setTimeout(resolve, 5_000);
      timeout.unref();
    })]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveDiscordGoalOutput(deliveryService, sessionId) {
  if (typeof deliveryService.resolveDiscordGoalRoute !== 'function'
    || typeof deliveryService.deliverDiscordGoalText !== 'function') return null;
  await waitForAdmission(sessionId);
  return deliveryService.resolveDiscordGoalRoute(sessionId);
}

/** Return whether this turn was handled by the exact route, including its cursor. */
export async function deliverDiscordGoalTurn({ deliveryService, sessionId, session, event, isSteer, signal }) {
  if (!session || !Number.isSafeInteger(event.seq) || signal?.aborted) return false;
  const route = await resolveDiscordGoalOutput(deliveryService, sessionId);
  if (signal?.aborted) return true;
  if (route?.ambiguous) return true;
  if (!route || route.sessionId !== sessionId) return false;
  const proof = discordGoalTurn({ events: sessionEvents(session), endEvent: event, route, isSteer });
  if (!proof) return false;
  if (proof.text && event.seq > route.deliverySeqFloor && event.seq > route.deliverySeqCursor) {
    await deliveryService.deliverDiscordGoalText(route, event.seq, proof.text, {
      signal,
      assertGoalCurrent: () => isStillCurrent(sessionEvents(session), route, event.seq),
    });
  }
  return true;
}
