import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStateStore } from '../src/channels/shared/conversation-state-store.mjs';

test('route control anchor survives restart only for its exact bot state, channel, key and session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-control-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'bot-one.json');
  const state = await new ConversationStateStore(path).load();
  await state.setSession('group:thread', 'session-one');
  const anchor = { channel: 'discord', sessionId: 'session-one', turn: 4, promptRpcId: 'discord-owned' };
  await state.rememberControlAnchor('group:thread', anchor);
  const restored = await new ConversationStateStore(path).load();
  assert.deepEqual(restored.controlAnchorFor('group:thread', 'discord'), anchor);
  assert.equal(restored.controlAnchorFor('group:other', 'discord'), null);
  assert.equal(restored.controlAnchorFor('group:thread', 'slack'), null);
  const other = await new ConversationStateStore(join(dir, 'bot-two.json')).load();
  await other.setSession('group:thread', 'session-one');
  assert.equal(other.controlAnchorFor('group:thread', 'discord'), null);
  const oldVersion = restored.controlBindingVersion('group:thread');
  await restored.setSession('group:thread', 'session-two');
  await restored.setSession('group:thread', 'session-one');
  assert.equal(restored.controlAnchorFor('group:thread', 'discord'), null);
  assert.equal(await restored.rememberControlAnchor('group:thread', anchor, oldVersion), false,
    'an old in-flight ask cannot restore a credential after rebind-away-and-back');
  await restored.rememberControlAnchor('group:thread', anchor);
  await restored.clearSession('group:thread');
  await restored.setSession('group:thread', 'session-one');
  assert.equal(restored.controlAnchorFor('group:thread', 'discord'), null);
});
