import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discordThreadOperation, installDiscordThreadTool } from '../plugin-src/host/discord-threads.mjs';

const channelId = '1484533935752085624';
const threadId = '1569416570344710279';
const guildId = '1468696024829792310';
const thread = { id: threadId, parent_id: channelId, guild_id: guildId, type: 11 };

test('thread dispatcher filters active threads and preserves archived pagination', async () => {
  const signal = new AbortController().signal;
  const archived = [{ ...thread, thread_metadata: { archive_timestamp: '2026-11-09T18:00:00Z' } }];
  const calls = [];
  const api = {
    async getChannel(args) { calls.push(args); return { id: channelId, guild_id: guildId, type: 0 }; },
    async listActiveThreads(args) { calls.push(args); return { threads: [thread, { ...thread, parent_id: 'other' }] }; },
    async listArchivedThreads(args) { calls.push(args); return { threads: archived, has_more: true }; },
  };
  assert.deepEqual(await discordThreadOperation(api, { action: 'list', channelId, before: '2026-11-10T00:00:00Z', limit: 20 }, signal), {
    active: [thread], archived, visibility: 'public', hasMoreArchived: true, nextBefore: '2026-11-09T18:00:00Z',
  });
  assert.deepEqual(calls, [{ channelId, signal }, { guildId, signal }, { channelId, before: '2026-11-10T00:00:00Z', limit: 20, visibility: 'public', signal }]);
  api.listArchivedThreads = async () => ({ threads: [], has_more: false });
  assert.equal((await discordThreadOperation(api, { action: 'list', channelId })).nextBefore, null);
});

test('text creation reports committed thread on starter failure without creating again', async () => {
  let creates = 0;
  let sends = 0;
  const api = {
    async getChannel() { return { type: 0, guild_id: guildId }; },
    async createThread(args) { creates++; assert.equal(args.channelId, channelId); return thread; },
    async createMessage(args) { sends++; assert.equal(args.channelId, threadId); throw new Error('transport timeout'); },
  };
  const result = await discordThreadOperation(api, { action: 'create', channelId, name: 'Ticket', content: 'Starter' });
  assert.equal(result.thread, thread);
  assert.equal(result.starterSent, null);
  assert.equal(result.initialMessageDelivery.status, 'unknown');
  assert.match(result.retry, /Inspect thread messages/);
  assert.equal(result.error, 'transport timeout');
  assert.match(result.retry, /do not create another thread/);
  assert.equal(creates, 1);
  assert.equal(sends, 1);
});

test('text success provides IDs while forum creation uses atomic starter operation', async () => {
  const signal = new AbortController().signal;
  const api = {
    async getChannel() { return { type: 0, guild_id: guildId }; },
    async createThread() { return thread; },
    async createMessage(args) { assert.equal(args.signal, signal); return { id: '1234567890' }; },
  };
  assert.deepEqual(await discordThreadOperation(api, { action: 'create', channelId, name: 'Ticket', content: 'Starter' }, signal), {
    thread, threadSnapshot: 'creation', messageId: '1234567890', initialMessageDelivery: { status: 'confirmed', messageId: '1234567890' }, url: `https://discord.com/channels/${guildId}/${threadId}/1234567890`,
  });
  for (const type of [15, 16]) {
    const forumApi = { async getChannel() { return { type, guild_id: guildId }; }, async createForumThread(args) {
      assert.deepEqual(args, { channelId, name: 'Ticket', content: 'Starter', autoArchiveDuration: undefined, rateLimitPerUser: undefined, auditReason: undefined, appliedTags: undefined, signal });
      return { ...thread, message: { id: '1234567890' } };
    } };
    assert.equal((await discordThreadOperation(forumApi, { action: 'create', channelId, name: 'Ticket', content: 'Starter' }, signal)).messageId, '1234567890');
  }
});

test('dispatcher rejects nonthreads for updates and sends before any mutation', async () => {
  for (const action of ['update', 'send']) {
    for (const type of [0, 1, 2, 15]) {
      await assert.rejects(discordThreadOperation({ async getThread() { return { type, guild_id: guildId }; } }, { action, threadId, archived: true, content: 'hello' }), /not a thread/);
    }
  }
  const signal = new AbortController().signal;
  await discordThreadOperation({ async getThread() { return thread; }, async updateThread(args) {
    assert.deepEqual(args, { threadId, name: undefined, archived: false, locked: false, autoArchiveDuration: undefined, rateLimitPerUser: undefined, appliedTags: undefined, invitable: undefined, auditReason: undefined, signal });
  } }, { action: 'update', threadId, archived: false, locked: false }, signal);
});

test('dispatcher rejects invalid create content, unsupported parents and unknown actions', async () => {
  await assert.rejects(discordThreadOperation({}, { action: 'create', channelId, content: '' }), /Content/);
  await assert.rejects(discordThreadOperation({ async getChannel() { return { type: 2, guild_id: guildId }; } }, { action: 'create', channelId, content: 'x' }), /text, announcement or forum/);
  await assert.rejects(discordThreadOperation({ async getChannel() { return { type: 1 }; } }, { action: 'list', channelId }), /limited to Satoshi Capital/);
  await assert.rejects(discordThreadOperation({}, { action: 'unknown' }), /Unknown thread action/);
});

test('all operations reject other guilds and DMs before further reads or mutation', async () => {
  for (const action of ['inspect', 'list', 'create', 'send', 'update', 'members', 'add-member', 'remove-member', 'join', 'leave', 'delete']) {
    for (const foreignGuild of ['999999999999999999', undefined]) {
      let reads = 0;
      const api = {
        async getChannel() { reads++; return { ...thread, guild_id: foreignGuild }; },
        async getThread() { reads++; return { ...thread, guild_id: foreignGuild }; },
      };
      await assert.rejects(discordThreadOperation(api, { action, channelId, threadId, name: 'Ticket', content: 'hello', archived: true }), /limited to Satoshi Capital/);
      assert.equal(reads, 1);
    }
  }
});

test('message-based and private thread creation preserve advanced parameters', async () => {
  let created;
  const api = { async getChannel() { return { type: 5, guild_id: guildId }; }, async startThreadFromMessage(args) { created = args; return thread; } };
  const result = await discordThreadOperation(api, { action: 'create', channelId, name: 'x', messageId: '1234567890', autoArchiveDuration: 60, auditReason: 'test' });
  assert.equal(created.messageId, '1234567890');
  assert.equal(created.autoArchiveDuration, 60);
  assert.equal(result.messageId, undefined);
  api.getChannel = async () => ({ type: 0, guild_id: guildId });
  api.createThread = async args => { created = args; return { ...thread, type: 12 }; };
  api.createMessage = async () => ({ id: '1234567890' });
  await discordThreadOperation(api, { action: 'create', channelId, name: 'x', content: 'x', visibility: 'private', invitable: false, rateLimitPerUser: 10 });
  assert.equal(created.type, 12);
  assert.equal(created.invitable, false);
  assert.equal(created.rateLimitPerUser, 10);
  await assert.rejects(discordThreadOperation(api, { action: 'create', channelId, name: 'x', messageId: '1234567890', visibility: 'private' }), /must be public/);
});

test('forum required tags are enforced and updates check the actual parent', async () => {
  const api = { async getChannel() { return { type: 15, flags: 16, guild_id: guildId }; }, async getThread() { return thread; } };
  await assert.rejects(discordThreadOperation(api, { action: 'create', channelId, name: 'x', content: 'x' }), /requires appliedTags/);
  api.createForumThread = async args => { assert.deepEqual(args.appliedTags, ['1234567890']); return { ...thread, message: { id: '1234567890' } }; };
  await discordThreadOperation(api, { action: 'create', channelId, name: 'x', content: 'x', appliedTags: ['1234567890'] });
  api.updateThread = async args => { assert.deepEqual(args.appliedTags, []); return thread; };
  await discordThreadOperation(api, { action: 'update', threadId, appliedTags: [] });
  api.getChannel = async () => ({ type: 0, guild_id: guildId });
  await assert.rejects(discordThreadOperation(api, { action: 'update', threadId, appliedTags: [] }), /forum parent/);
  await assert.rejects(discordThreadOperation(api, { action: 'update', threadId, invitable: false }), /private thread/);
});

test('member operations and joined-private listing expose correct pagination', async () => {
  const api = { async getThread() { return thread; }, async listThreadMembers(args) { assert.equal(args.withMember, true); return [{ user_id: '1234567890' }]; } };
  assert.deepEqual(await discordThreadOperation(api, { action: 'members', threadId, limit: 1 }), { members: [{ user_id: '1234567890' }], nextAfter: '1234567890', mayHaveMore: true });
  for (const [action, method] of Object.entries({ 'add-member': 'addThreadMember', 'remove-member': 'removeThreadMember', join: 'joinThread', leave: 'leaveThread' })) {
    let called = false;
    api[method] = async args => { called = true; assert.equal(args.threadId, threadId); };
    assert.equal((await discordThreadOperation(api, { action, threadId, userId: '1234567890' })).success, true);
    assert.equal(called, true);
  }
  api.getChannel = async () => ({ type: 0, guild_id: guildId });
  api.listActiveThreads = async () => ({ threads: [] });
  api.listArchivedThreads = async args => { assert.equal(args.visibility, 'joined-private'); return { threads: [thread], has_more: true }; };
  assert.equal((await discordThreadOperation(api, { action: 'list', channelId, visibility: 'joined-private' })).nextBefore, threadId);
});

test('thread deletion requires explicit confirmation and only deletes inspected thread', async () => {
  let deletes = 0;
  const api = { async getThread() { return thread; }, async deleteChannel(args) { deletes++; assert.equal(args.channelId, threadId); return thread; } };
  await assert.rejects(discordThreadOperation(api, { action: 'delete', threadId }), /confirm=true/);
  assert.equal(deletes, 0);
  assert.equal(await discordThreadOperation(api, { action: 'delete', threadId, confirm: true }), thread);
  assert.equal(deletes, 1);
});

test('tool registration uses credentials resolver without returning token metadata', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-discord-thread-test-'));
  const previousFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = previousFetch; await rm(home, { recursive: true, force: true }); });
  await mkdir(join(home, 'integrations/dsh-discord'), { recursive: true });
  await writeFile(join(home, 'integrations/dsh-discord/config.json'), JSON.stringify({ bots: [{ botId: 'discord_test', tokenRef: 'test-ref' }] }));
  let tool;
  const token = `${'a'.repeat(25)}.aaaa.${'b'.repeat(25)}`;
  installDiscordThreadTool({
    inject(deps, callback) { assert.deepEqual(deps, ['tools']); callback({ tools: { register(definition) { tool = definition; } } }); },
    credentials: { async resolve(ref) { assert.equal(ref, 'test-ref'); return { value: token }; } },
  }, { dshHome: home });
  assert.equal(tool.name, 'dsh_discord_thread');
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.properties.action.enum, ['inspect', 'list', 'create', 'send', 'update', 'members', 'add-member', 'remove-member', 'join', 'leave', 'delete']);
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, `/api/v10/channels/${threadId}`);
    assert.equal(options.headers.authorization, `Bot ${token}`);
    return Response.json(thread);
  };
  const result = await tool.execute({ action: 'inspect', threadId }, { signal: new AbortController().signal });
  assert.deepEqual(result, thread);
  assert.doesNotMatch(JSON.stringify(tool.output.render({}, result)), /test-ref/);
  await assert.rejects(tool.execute({ action: 'inspect', threadId, botId: 'missing' }, {}), /Specify a configured/);
});
