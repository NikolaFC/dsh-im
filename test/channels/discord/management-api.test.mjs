import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordApi } from '../../../src/channels/discord/discord-api.mjs';
const token = `${'a'.repeat(25)}.aaaa.${'b'.repeat(25)}`;
const channelId = '111111111111111111';
const guildId = '222222222222222222';
const messageId = '333333333333333333';
const threadId = channelId;
const userId = messageId;
const before = '2026-11-09T14:00:00.123+01:00';
function mock(status = 200, result = { id: channelId }) {
  const calls = [];
  const api = new DiscordApi({ token, fetchImpl: async (url, options) => {
    calls.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
    return status === 204 ? new Response(null, { status }) : Response.json(result, { status });
  } });
  return { api, calls };
}

test('guild channel methods map bounded fields and encoded audit reason', async () => {
  const { api, calls } = mock();
  await api.listGuildChannels({ guildId });
  assert.equal(calls[0].url.pathname, `/api/v10/guilds/${guildId}/channels`);
  await api.createGuildChannel({ guildId, name: 'Forum', type: 15, topic: 'a'.repeat(4096), parentId: channelId, position: 0, rateLimitPerUser: 0, availableTags: [{ name: 'done', moderated: false, emojiName: '✅' }], auditReason: '测试 / rename' });
  assert.deepEqual(calls[1].body, { name: 'Forum', type: 15, topic: 'a'.repeat(4096), parent_id: channelId, position: 0, rate_limit_per_user: 0, available_tags: [{ name: 'done', moderated: false, emoji_name: '✅' }] });
  assert.equal(calls[1].headers['X-Audit-Log-Reason'], encodeURIComponent('测试 / rename'));
  await api.updateChannel({ channelId, topic: null, parentId: null, availableTags: [] });
  assert.deepEqual(calls[2].body, { topic: null, parent_id: null, available_tags: [] });
  assert.equal(calls[2].method, 'PATCH');
  assert.deepEqual(await api.deleteChannel({ channelId }), { id: channelId });
  assert.equal(calls[3].method, 'DELETE');
  for (const type of [0, 2, 4]) await api.createGuildChannel({ guildId, name: 'Test', type });
});

test('channel move uses exactly one entry and 204, with explicit permission sync', async () => {
  const { api, calls } = mock(204);
  assert.equal(await api.moveChannel({ guildId, channelId, position: 0, parentId: null, lockPermissions: false }), null);
  assert.equal(calls[0].url.pathname, `/api/v10/guilds/${guildId}/channels`);
  assert.deepEqual(calls[0].body, [{ id: channelId, position: 0, parent_id: null, lock_permissions: false }]);
});

test('current pin routes use timestamp pagination and bodyless 204 mutations', async () => {
  const { api, calls } = mock(200, { items: [], has_more: true });
  assert.deepEqual(await api.listPins({ channelId, before, limit: 50 }), { items: [], has_more: true });
  assert.equal(calls[0].url.pathname, `/api/v10/channels/${channelId}/messages/pins`);
  assert.equal(calls[0].url.searchParams.get('before'), before);
  const mutations = mock(204);
  for (const method of ['pinMessage', 'unpinMessage']) assert.equal(await mutations.api[method]({ channelId, messageId, auditReason: 'test' }), null);
  assert.deepEqual(mutations.calls.map(c => c.method), ['PUT', 'DELETE']);
  for (const call of mutations.calls) {
    assert.equal(call.url.pathname, `/api/v10/channels/${channelId}/messages/pins/${messageId}`);
    assert.equal(call.body, undefined);
    assert.equal(call.headers['X-Audit-Log-Reason'], 'test');
  }
});

test('message pagination cursors and delete use expected routes', async () => {
  const { api, calls } = mock(200, []);
  for (const cursor of ['before', 'after', 'around']) {
    await api.listMessages({ channelId, [cursor]: messageId, limit: 100 });
    assert.equal(calls.at(-1).url.searchParams.get(cursor), messageId);
    assert.equal(calls.at(-1).url.pathname, `/api/v10/channels/${channelId}/messages`);
  }
  const deletion = mock(204);
  assert.equal(await deletion.api.deleteMessage({ channelId, messageId }), null);
  assert.equal(deletion.calls[0].url.pathname, `/api/v10/channels/${channelId}/messages/${messageId}`);
});

test('private threads, tag updates, and archive cursor types stay distinct', async () => {
  const { api, calls } = mock();
  await api.createThread({ channelId, name: 'private', type: 12, invitable: false, auditReason: 'test' });
  assert.deepEqual(calls[0].body, { name: 'private', type: 12, invitable: false });
  await api.updateThread({ threadId, invitable: false, appliedTags: [], rateLimitPerUser: 0 });
  assert.deepEqual(calls[1].body, { invitable: false, applied_tags: [], rate_limit_per_user: 0 });
  await api.listArchivedThreads({ channelId, visibility: 'private', before });
  assert.equal(calls[2].url.pathname, `/api/v10/channels/${channelId}/threads/archived/private`);
  await api.listArchivedThreads({ channelId, visibility: 'joined-private', before: threadId });
  assert.equal(calls[3].url.pathname, `/api/v10/channels/${channelId}/users/@me/threads/archived/private`);
  assert.equal(calls[3].url.searchParams.get('before'), threadId);
});

test('thread membership paginates explicitly and supports bodyless membership operations', async () => {
  const { api, calls } = mock(200, []);
  await api.listThreadMembers({ threadId, after: userId, limit: 100 });
  assert.equal(calls[0].url.searchParams.get('with_member'), 'true');
  assert.equal(calls[0].url.searchParams.get('after'), userId);
  const mutations = mock(204);
  for (const method of ['addThreadMember', 'removeThreadMember', 'joinThread', 'leaveThread']) assert.equal(await mutations.api[method]({ threadId, userId }), null);
  assert.deepEqual(mutations.calls.map(c => c.method), ['PUT', 'DELETE', 'PUT', 'DELETE']);
  assert.deepEqual(mutations.calls.map(c => c.url.pathname.split('/').at(-1)), [userId, userId, '@me', '@me']);
});

test('invalid management requests fail before network', async () => {
  const { api, calls } = mock();
  for (const run of [
    () => api.createGuildChannel({ guildId, name: 'x', type: 1 }),
    () => api.createGuildChannel({ guildId, name: 'x', topic: 'a'.repeat(1025) }),
    () => api.updateChannel({ channelId }),
    () => api.updateChannel({ channelId, availableTags: [{ name: 'a'.repeat(21) }] }),
    () => api.updateChannel({ channelId, availableTags: [{ name: 'x', emojiId: userId, emojiName: 'x' }] }),
    () => api.moveChannel({ guildId, channelId, lockPermissions: true }),
    () => api.listMessages({ channelId, before: messageId, after: messageId }),
    () => api.listPins({ channelId, limit: 51 }),
    () => api.listPins({ channelId, before: messageId }),
    () => api.createThread({ channelId, name: 'x', type: 11, invitable: true }),
    () => api.listArchivedThreads({ channelId, visibility: 'joined-private', before }),
    () => api.listArchivedThreads({ channelId, visibility: 'private', before: threadId }),
    () => api.listThreadMembers({ threadId, withMember: false, limit: 10 }),
    () => api.updateThread({ threadId, appliedTags: [userId, userId] }),
    () => api.pinMessage({ channelId, messageId, auditReason: 'x'.repeat(513) }),
  ]) await assert.rejects(async () => run(), TypeError);
  assert.equal(calls.length, 0);
});

test('audit header survives 429; uncertain POST is never retried', async () => {
  let calls = 0;
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const api = new DiscordApi({ token, fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.headers['X-Audit-Log-Reason'], encodeURIComponent('测试'));
      return calls === 1 ? Response.json({ retry_after: 0.001 }, { status: 429 }) : Response.json({ id: channelId });
    } });
    await api.createGuildChannel({ guildId, name: 'x', auditReason: '测试' });
    assert.equal(calls, 2);
  } finally { clearInterval(keepAlive); }
  calls = 0;
  const api = new DiscordApi({ token, fetchImpl: async () => { calls++; throw new Error('network lost'); } });
  await assert.rejects(api.createGuildChannel({ guildId, name: 'x' }), /transport failed/);
  assert.equal(calls, 1);
});
