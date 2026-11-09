import assert from 'node:assert/strict';
import test from 'node:test';

import { DiscordHarnessBridge } from '../../../src/channels/discord/discord-bridge.mjs';

function message(messageId, content) {
  return {
    messageId,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content,
    addressed: true,
    replyTarget: { id: `target-${messageId}` },
  };
}

function fixture() {
  const sessions = new Map([['direct:chat-a', 'session-one']]);
  const seen = new Set();
  return {
    state: {
      sessionFor(key) { return sessions.get(key) ?? null; },
      async setSession(key, sessionId) { sessions.set(key, sessionId); return true; },
      async clearSession(key) { sessions.delete(key); },
      hasSeen(messageId) { return seen.has(messageId); },
      async markSeen(messageId) { seen.add(messageId); },
      async unmarkSeen(messageId) { return seen.delete(messageId); },
    },
  };
}

test('permission commands reach the Host preset switches from a text channel', async () => {
  const sent = [];
  let executed = [];
  const options = [
    { value: 'workspace-write', name: 'workspace-write', description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.' },
    { value: 'danger-full-access', name: 'danger-full-access', description: 'Full file access without approval prompts.' },
  ];
  const bridge = new DiscordHarnessBridge({
    bot: { sendText: async (_target, text) => sent.push(text) },
    state: fixture().state,
    harness: {
      ask: async () => 'unexpected model reply',
      workspaceSession: () => ({
        permissions: async () => ({ currentValue: 'danger-full-access', options }),
        executeCommand: async (line) => {
          executed.push(line);
          return { result: { kind: 'success', text: 'preset workspace-write' } };
        },
      }),
    },
  });

  await bridge.accept(message('permission-list', '/permissionlist'));
  const listing = sent.at(-1);
  // Assert on preset ids, not localized copy: another suite may have switched the interface language.
  assert.match(listing, /danger-full-access/);
  assert.match(listing, /workspace-write/);
  assert.equal(listing.split('\n').filter(line => line.includes('danger-full-access')).length >= 1, true);

  await bridge.accept(message('permission-switch', '/permission workspace-write'));
  assert.deepEqual(executed, ['/permission workspace-write']);
  assert.match(sent.at(-1), /workspace-write/);

  await bridge.accept(message('permission-current', '/permission'));
  assert.match(sent.at(-1), /danger-full-access/);
  assert.equal(executed.length, 1, 'a bare /permission only reads');
});
