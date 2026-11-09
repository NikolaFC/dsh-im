import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordApi } from '../../../src/channels/discord/discord-api.mjs';

const token = `${'a'.repeat(25)}.aaaa.${'b'.repeat(25)}`;
const channelId = '1484533935752085624';
const threadId = '1484533935752085625';
const guildId = '1484533935752085626';
function mock(result = { id: threadId }) {
  const calls = [];
  const api = new DiscordApi({ token, fetchImpl: async (url, options) => {
    calls.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
    return Response.json(result);
  } });
  return { api, calls };
}

test('thread reads preserve provider IDs and pagination and use Bot auth', async () => {
  const result = { threads: [{ id: threadId, parent_id: channelId }], members: [], has_more: true };
  const { api, calls } = mock(result);
  assert.deepEqual(await api.getThread({ threadId }), result);
  assert.equal(calls[0].url.pathname, `/api/v10/channels/${threadId}`);
  assert.deepEqual(await api.listActiveThreads({ guildId }), result);
  assert.equal(calls[1].url.pathname, `/api/v10/guilds/${guildId}/threads/active`);
  const before = '2026-11-09T14:30:00.123+01:00';
  assert.deepEqual(await api.listArchivedThreads({ channelId, before, limit: 100 }), result);
  assert.equal(calls[2].url.pathname, `/api/v10/channels/${channelId}/threads/archived/public`);
  assert.equal(calls[2].url.searchParams.get('before'), before);
  assert.equal(calls[2].url.searchParams.get('limit'), '100');
  await api.listArchivedThreads({ channelId });
  assert.equal(calls[3].url.search, '');
  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.headers.authorization, `Bot ${token}`);
    assert.equal(call.body, undefined);
  }
});

test('public and forum thread creation emit their distinct Discord wire bodies', async () => {
  const result = { id: threadId, message: { id: '1484533935752085627' } };
  const { api, calls } = mock(result);
  assert.deepEqual(await api.createThread({ channelId, name: ' Ticket ', autoArchiveDuration: 1440, rateLimitPerUser: 0 }), result);
  assert.deepEqual(calls[0].body, { name: 'Ticket', type: 11, auto_archive_duration: 1440, rate_limit_per_user: 0 });
  assert.deepEqual(await api.createForumThread({ channelId, name: 'Ticket', content: '@everyone test', appliedTags: [guildId] }), result);
  assert.deepEqual(calls[1].body, { name: 'Ticket', message: { content: '@everyone test', allowed_mentions: { parse: [], replied_user: false } }, applied_tags: [guildId] });
  for (const call of calls) {
    assert.equal(call.method, 'POST');
    assert.equal(call.url.pathname, `/api/v10/channels/${channelId}/threads`);
  }
});

test('thread update only changes explicitly supplied fields including false values', async () => {
  const { api, calls } = mock();
  await api.updateThread({ threadId, name: 'Resolved', archived: true, locked: true });
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url.pathname, `/api/v10/channels/${threadId}`);
  assert.deepEqual(calls[0].body, { name: 'Resolved', archived: true, locked: true });
  await api.updateThread({ threadId, archived: false, locked: false, autoArchiveDuration: 60, rateLimitPerUser: 21600 });
  assert.deepEqual(calls[1].body, { auto_archive_duration: 60, rate_limit_per_user: 21600, archived: false, locked: false });
});

test('invalid thread requests never reach the transport', () => {
  const { api, calls } = mock();
  const invalid = [
    () => api.getThread({ threadId: '../other' }),
    () => api.listActiveThreads({ guildId: 'x' }),
    () => api.listArchivedThreads({ channelId, limit: 0 }),
    () => api.listArchivedThreads({ channelId, limit: 101 }),
    () => api.listArchivedThreads({ channelId, before: 'yesterday' }),
    () => api.listArchivedThreads({ channelId, before: '2026-11-09T12:00:00' }),
    () => api.createThread({ channelId, name: ' ' }),
    () => api.createThread({ channelId, name: 'a'.repeat(101) }),
    () => api.createThread({ channelId, name: 'x', autoArchiveDuration: 61 }),
    () => api.createThread({ channelId, name: 'x', rateLimitPerUser: -1 }),
    () => api.createThread({ channelId, name: 'x', rateLimitPerUser: 1.5 }),
    () => api.createForumThread({ channelId, name: 'x', content: '' }),
    () => api.createForumThread({ channelId, name: 'x', content: 'a'.repeat(2001) }),
    () => api.createForumThread({ channelId, name: 'x', content: 'ok', appliedTags: [guildId, guildId] }),
    () => api.createForumThread({ channelId, name: 'x', content: 'ok', appliedTags: ['invalid'] }),
    () => api.updateThread({ threadId }),
    () => api.updateThread({ threadId, archived: 'false' }),
    () => api.updateThread({ threadId, locked: null }),
    () => api.updateThread({ threadId, rateLimitPerUser: 21601 }),
  ];
  for (const run of invalid) assert.throws(run, TypeError);
  assert.equal(calls.length, 0);
});

test('pre-aborted thread mutations do not reach the transport', () => {
  const { api, calls } = mock();
  const reason = new Error('cancelled by caller');
  const signal = AbortSignal.abort(reason);
  for (const run of [
    () => api.createThread({ channelId, name: 'Ticket', signal }),
    () => api.createForumThread({ channelId, name: 'Ticket', content: 'hello', signal }),
    () => api.updateThread({ threadId, archived: true, signal }),
  ]) assert.throws(run, error => error === reason);
  assert.equal(calls.length, 0);
});

test('thread API preserves Discord permission error status and code', async () => {
  const api = new DiscordApi({ token, fetchImpl: async () => Response.json({ code: 50013, message: 'Missing Permissions' }, { status: 403 }) });
  await assert.rejects(api.updateThread({ threadId, locked: true }), error => {
    assert.equal(error.code, 'discord-403');
    assert.equal(error.providerCode, 50013);
    assert.equal(error.status, 403);
    return true;
  });
});
