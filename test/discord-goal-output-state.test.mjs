import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHarnessCommandExecutor } from '../plugin-src/host/harness-command-executor.mjs';
import { DiscordStateStore } from '../src/channels/discord/state-store.mjs';
import { waitForPendingDiscordGoalOutput } from '../src/channels/shared/discord-goal-output.mjs';
import { runGoalCommand } from '../src/channels/shared/goal-command.mjs';

const key = 'group:1234';
const actor = '4321';
const seed = { sessionId: 'session-test', goalId: 'goal-test', revision: 1, actor, goalStartSeq: 10, deliverySeqFloor: 12 };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-goal-route-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const file = join(directory, 'state.json');
  const state = await new DiscordStateStore(file).load();
  await state.setSession(key, seed.sessionId);
  return { state, file };
}

test('Discord goal route persists exact authority and claims each dispatch sequence once', async t => {
  const { state, file } = await fixture(t);
  assert.equal(await state.rememberGoalOutputRoute(key, seed, state.controlBindingVersion(key)), true);
  const route = state.goalOutputRouteFor(key);
  assert.equal(route.deliverySeqCursor, 12);
  assert.equal(await state.claimGoalOutput(key, route, 11), false);
  assert.equal(await state.claimGoalOutput(key, { ...route, actor: '5' }, 13), false);
  assert.deepEqual(await Promise.all([
    state.claimGoalOutput(key, route, 13), state.claimGoalOutput(key, route, 13),
  ]), [true, false]);
  assert.equal(await state.claimGoalOutput(key, route, 14), true);
  const persisted = JSON.parse(await readFile(file, 'utf8')).goalOutputRoutes[key];
  assert.equal(persisted.deliverySeqCursor, 14);
  assert.equal(Object.hasOwn(persisted, 'bindingVersion'), false);
  const reloaded = await new DiscordStateStore(file).load();
  assert.equal(reloaded.goalOutputRouteFor(key).routeId, route.routeId);
  assert.equal(await reloaded.claimGoalOutput(key, reloaded.goalOutputRouteFor(key), 14), false);
});

test('Discord route guards rebind ABA, superseded resumes and clearing all sessions', async t => {
  const { state, file } = await fixture(t);
  const version = state.controlBindingVersion(key);
  await state.rememberGoalOutputRoute(key, seed, version);
  const previous = state.goalOutputRouteFor(key);
  const resumed = { ...seed, revision: 3, goalStartSeq: 20, deliverySeqFloor: 20 };
  assert.equal(await state.rememberGoalOutputRoute(key, resumed, version), true);
  assert.equal(await state.claimGoalOutput(key, previous, 21), false);
  assert.equal(await state.rememberGoalOutputRoute(key, seed, version), false);
  await state.setSession(key, 'session-other');
  await state.setSession(key, seed.sessionId);
  assert.equal(state.goalOutputRouteFor(key), null);
  assert.equal(await state.rememberGoalOutputRoute(key, resumed, version), false);
  await state.rememberGoalOutputRoute(key, resumed, state.controlBindingVersion(key));
  await state.clearSessions();
  assert.equal(state.goalOutputRouteFor(key), null);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).goalOutputRoutes, undefined);
});

test('Discord create captures only the committed mutation ref, including before a racing goals/get', async t => {
  const { state } = await fixture(t);
  const entered = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  const events = [];
  const calls = [];
  const executor = createHarnessCommandExecutor({
    get: service => service === 'agents'
      ? { get: id => ({ session: { id, snapshotEvents: () => events.slice() } }) } : undefined,
    typertGateway: { async invoke(call) {
      calls.push(call.method);
      if (call.method === 'create') {
        events.push({ type: 'goal/change', seq: 10, data: {
          operation: 'create', goal: { id: seed.goalId, revision: 1 },
        } });
        entered.resolve();
        await proceed.promise;
        return { ref: { id: seed.goalId, revision: 1 } };
      }
      if (calls.length === 1) return null;
      assert.equal(state.goalOutputRouteFor(key)?.goalId, seed.goalId);
      return { id: 'other-goal', revision: 1, objective: 'another goal' };
    } },
  });
  const harness = { workspaceSession: id => ({ executeCommand: (line, options) => executor(id, line, options) }) };
  const create = runGoalCommand('/goal a test goal', harness, state, key, { discordGoalActor: () => actor });
  await entered.promise;
  const pending = waitForPendingDiscordGoalOutput(seed.sessionId);
  assert.ok(pending);
  assert.equal(state.goalOutputRouteFor(key), null);
  proceed.resolve();
  assert.equal((await create).goal.id, seed.goalId);
  await pending;
  assert.equal(waitForPendingDiscordGoalOutput(seed.sessionId), undefined);
  assert.equal(state.goalOutputRouteFor(key).goalStartSeq, 10);
  assert.equal(state.goalOutputRouteFor(key).deliverySeqFloor, 10);
});

test('status, pause, revoked actors, and a binding ABA cannot record new goal authority', async t => {
  const { state } = await fixture(t);
  let authorized = true;
  let effect;
  const options = { discordGoalActor: () => authorized ? actor : null };
  const harness = { workspaceSession: () => ({
    async executeCommand(_line, { onGoalMutation }) {
      if (onGoalMutation) {
        await effect();
        await onGoalMutation({ goalId: seed.goalId, goalStartSeq: 12, revision: 3 });
      }
      return { result: { kind: 'success', text: 'goal' } };
    },
  }) };
  effect = () => assert.fail('status and pause must not register a goal mutation');
  await runGoalCommand('/goal status', harness, state, key, options);
  await runGoalCommand('/goal pause', harness, state, key, options);
  effect = () => { authorized = false; };
  await runGoalCommand('/goal resume', harness, state, key, options);
  assert.equal(state.goalOutputRouteFor(key), null);
  authorized = true;
  effect = async () => {
    await state.setSession(key, 'session-other');
    await state.setSession(key, seed.sessionId);
  };
  const result = await runGoalCommand('/goal resume', harness, state, key, options);
  assert.match(result.message, /workspace-session-stale/);
  assert.equal(state.goalOutputRouteFor(key), null);
});
