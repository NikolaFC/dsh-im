import assert from 'node:assert/strict';
import test from 'node:test';
import { discordGoalTurn } from '../plugin-src/host/discord-goal-sync.mjs';
import { createSessionSyncCoordinator } from '../plugin-src/host/session-sync-coordinator.mjs';
import { beginDiscordGoalOutputAdmission } from '../src/channels/shared/discord-goal-output.mjs';

const sessionId = 'session-owned';
const goal = { id: 'goal-owned', revision: 1, phase: 'active' };
const route = {
  sessionId,
  botId: 'discord-bot',
  conversationKey: 'group:123',
  goalId: goal.id,
  revision: goal.revision,
  goalStartSeq: 0,
  deliverySeqFloor: 0,
  deliverySeqCursor: 0,
};

const goalInput = (round = 1) => ({ kind: 'goal', goalId: goal.id, revision: goal.revision, round });
const relay = senderSessionId => ({ kind: 'agent-message', form: 'relay', senderSessionId });
const settled = senderSessionId => ({ kind: 'subagent-settled', form: 'notice', senderSessionId });

function sequence() {
  const events = [];
  const append = (type, data, surfaceOp) => {
    const event = { type, data, surfaceOp, seq: events.length };
    events.push(event);
    return event;
  };
  const input = source => append('user/message', { source }, 'append');
  const answer = (turn, text, more = []) => append('assistant/message', { turn, step: 1,
    message: { content: [{ type: 'text', text }, ...more] },
  }, 'append');
  const close = (turn, kind = 'completed') => append('turn/end', { turn, reason: { kind } });
  const change = (operation, next) => append('goal/change', { operation, goal: next });
  change('create', goal);
  return {
    events,
    input,
    answer,
    close,
    change,
    append,
    track(turn, sources, children = []) {
      append('turn/start', { turn });
      input({ kind: 'runtime-context', form: 'snapshot' });
      for (const source of sources) input(source);
      for (const childId of children) append('subagent/catalog', { childId });
    },
    proof(endEvent, options = {}) {
      return discordGoalTurn({ events, route, endEvent, ...options });
    },
  };
}

test('goal and verified descendant messages inherit the conversation through several turns', () => {
  const s = sequence();
  for (const [turn, sources, children] of [
    [9, [goalInput()], ['A', 'B']],
    [10, [relay('B'), settled('A'), settled('B')], ['C']],
    [11, [settled('C')], ['D']],
    [12, [relay('D')], []],
    [13, [relay('D'), settled('D')], []],
  ]) {
    s.track(turn, sources, children);
    s.answer(turn, `answer ${turn}`);
    assert.deepEqual(s.proof(s.close(turn)), { text: `answer ${turn}` });
  }
  s.track(14, [goalInput(2)]);
  s.answer(14, 'wrap-up preamble', [{ type: 'tool-call' }]);
  s.append('tool/call', { turn: 14, name: 'update_goal' });
  s.change('complete', { ...goal, revision: 2, phase: 'complete' });
  s.input({ kind: 'tool-goal', form: 'notice' });
  s.answer(14, 'final answer');
  assert.deepEqual(s.proof(s.close(14)), { text: 'final answer' });
  s.track(15, [relay('D')]);
  s.answer(15, 'after completion');
  assert.equal(s.proof(s.close(15)), null);
});

test('unproven child, human input, unrelated service and foreign goal do not own the route', () => {
  const s = sequence();
  s.track(1, [goalInput()], ['child']);
  s.close(1);
  for (const [turn, sources] of [
    [2, [relay('unknown')]],
    [3, [relay('child'), { kind: 'schedule', form: 'notice' }]],
    [4, [relay('child'), { kind: 'user', rpcId: 'discord-steer-looking' }]],
    [5, [relay('child')]],
    [6, [{ ...goalInput(), goalId: 'different' }]],
    [7, [goalInput(2), { kind: 'tool-goal', form: 'notice' }]],
  ]) {
    s.track(turn, sources, ['untrusted-descendant']);
    s.answer(turn, 'private output');
    assert.equal(s.proof(s.close(turn)), null);
  }
  s.track(8, [goalInput(3), { kind: 'user', rpcId: 'verified-steer' }]);
  s.answer(8, 'owned');
  const end = s.close(8);
  assert.deepEqual(s.proof(end, { isSteer: event => event.data?.source?.rpcId === 'verified-steer' }), { text: 'owned' });
  assert.equal(s.proof(end), null);
});

test('replacement, clear, failed turns and duplicate role claims do not leak outputs', () => {
  const s = sequence();
  s.track(1, [goalInput()], ['child']);
  s.answer(1, 'interrupted');
  assert.deepEqual(s.proof(s.close(1, 'interrupted')), { text: '' });
  s.track(2, [relay('child')]);
  assert.equal(s.proof(s.close(2)), null, 'a noncompleted turn cannot transfer authority to a child');
  s.track(3, [goalInput(2)]);
  s.answer(3, 'replacement');
  s.change('create', { ...goal, id: 'new-goal' });
  assert.equal(s.proof(s.close(3)), null);
  s.track(4, [goalInput(3)]);
  s.append('goal/change', { operation: 'clear', cleared: { id: goal.id, revision: 2 } });
  s.answer(4, 'cleared');
  assert.equal(s.proof(s.close(4)), null);
});

function syncFixture(s, { current = route, masterOn = false, beforeDispatch, log = [] } = {}) {
  let cursor = current.deliverySeqCursor;
  const mirror = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: {
      async resolveDiscordGoalRoute(id) {
        assert.equal(id, sessionId);
        return { ...current, deliverySeqCursor: cursor };
      },
      async deliverDiscordGoalText(credential, endSeq, text, options) {
        beforeDispatch?.();
        if (!options.assertGoalCurrent()) return false;
        assert.equal(credential.botId, route.botId);
        assert.equal(credential.conversationKey, route.conversationKey);
        log.push([endSeq, text]);
        cursor = endSeq;
        return true;
      },
      async deliverSessionText(...args) { mirror.push(args); return { sent: true }; },
      async listSessionSyncTargets() { return []; },
      async describeConversation() { return { channel: 'discord', botId: route.botId }; },
    },
    loadSettings: () => ({ deliverModelAnswers: masterOn }),
    liveSegments: () => true,
  });
  const session = { snapshotEvents: () => s.events };
  return { emit: (event, origin) => coordinator.enqueue(sessionId, event, origin, session), log, mirror };
}

test('initial goal turn can seal before the command receipt without losing its answer', async (t) => {
  const s = sequence();
  s.track(1, [goalInput()]);
  s.answer(1, 'initial answer');
  const release = beginDiscordGoalOutputAdmission(sessionId);
  t.after(release);
  const f = syncFixture(s);
  const end = s.close(1);
  const completion = f.emit(end);
  await new Promise(setImmediate);
  assert.deepEqual(f.log, []);
  release();
  await completion;
  assert.deepEqual(f.log, [[end.seq, 'initial answer']]);
});

for (const masterOn of [false, true]) {
  test(`exact goal final answer uses just one route when the generic mirror is ${masterOn ? 'on' : 'off'}`, async () => {
    const s = sequence();
    s.track(1, [goalInput()]);
    s.answer(1, 'intermediate', [{ type: 'tool-call' }]);
    s.append('tool/call', { turn: 1 });
    s.answer(1, 'final');
    const end = s.close(1);
    const f = syncFixture(s, { masterOn });
    for (const event of s.events) await f.emit(event);
    await f.emit(end);
    assert.deepEqual(f.log, [[end.seq, 'final']]);
    assert.deepEqual(f.mirror, []);
  });
}

test('a new coordinator can restore ancestry without replaying pre-floor or dispatched output', async () => {
  const s = sequence();
  s.track(1, [goalInput()], ['child']);
  s.answer(1, 'historical original');
  const historical = s.close(1);
  s.track(2, [settled('child')], ['grandchild']);
  s.answer(2, 'after migration');
  const first = s.close(2);
  s.track(3, [settled('grandchild')]);
  s.answer(3, 'after restart');
  const next = s.close(3);
  const current = { ...route, deliverySeqFloor: historical.seq, deliverySeqCursor: first.seq };
  const f = syncFixture(s, { current, masterOn: true });
  for (const event of [historical, first, next]) await f.emit(event);
  assert.deepEqual(f.log, [[next.seq, 'after restart']]);
  assert.deepEqual(f.mirror, []);
});

test('a turn that only produced its answer before adoption has no new text to deliver', async () => {
  const s = sequence();
  s.track(1, [goalInput()]);
  const prior = s.answer(1, 'previous output');
  const end = s.close(1);
  const current = { ...route, deliverySeqFloor: prior.seq, deliverySeqCursor: prior.seq };
  const f = syncFixture(s, { current, masterOn: true });
  await f.emit(end);
  assert.deepEqual(f.log, []);
  assert.deepEqual(f.mirror, []);
});

test('a live replacement or ambiguous route can never fall back to the generic mirror', async () => {
  const s = sequence();
  s.track(1, [goalInput()]);
  s.answer(1, 'owned, then replaced');
  const end = s.close(1);
  const f = syncFixture(s, { masterOn: true, beforeDispatch: () => s.change('create', { ...goal, id: 'new-goal' }) });
  for (const event of s.events.slice()) await f.emit(event);
  assert.deepEqual(f.log, []);
  assert.deepEqual(f.mirror, []);
  const ambiguous = syncFixture(s, { current: { ambiguous: true }, masterOn: true });
  for (const event of s.events.filter(event => event.seq <= end.seq)) await ambiguous.emit(event);
  assert.deepEqual(ambiguous.log, []);
  assert.deepEqual(ambiguous.mirror, []);
});

for (const [label, operation, terminal, laterTurn, expected] of [
  ['an immediate completion', 'complete', { ...goal, phase: 'complete', revision: 2 }, false, true],
  ['the native round limit', 'block', {
    ...goal, phase: 'blocked', revision: 2, blockedReason: { code: 'round-limit' },
  }, false, true],
  ['a different block', 'block', {
    ...goal, phase: 'blocked', revision: 2, blockedReason: { code: 'policy' },
  }, false, false],
  ['a different revision', 'complete', { ...goal, phase: 'complete', revision: 3 }, false, false],
  ['a superseding turn', 'complete', { ...goal, phase: 'complete', revision: 2 }, true, false],
]) {
  test(`final delivery after ${label} stays within the sealed goal boundary`, async () => {
    const s = sequence();
    s.track(1, [goalInput()]);
    s.answer(1, 'final');
    const end = s.close(1);
    const f = syncFixture(s, { masterOn: true, beforeDispatch: () => {
      if (laterTurn) s.track(2, [{ kind: 'user' }]);
      s.change(operation, terminal);
    } });
    for (const event of s.events.slice()) await f.emit(event);
    assert.deepEqual(f.log, expected ? [[end.seq, 'final']] : []);
    assert.deepEqual(f.mirror, []);
  });
}

test('ordinary Discord ask owns its reply even if it includes an agent message', async () => {
  const s = sequence();
  s.track(1, [goalInput()], ['child']);
  s.close(1);
  s.track(2, [relay('child')]);
  const ordinary = s.input({ kind: 'user', rpcId: 'registered-ordinary-discord-prompt' });
  s.answer(2, 'ordinary answer');
  const end = s.close(2);
  const f = syncFixture(s, { masterOn: true });
  for (const event of s.events.filter(event => event.seq > 3 && event.seq <= end.seq)) {
    await f.emit(event, event === ordinary ? 'im' : 'other');
  }
  assert.deepEqual(f.log, []);
  assert.deepEqual(f.mirror, []);
});
