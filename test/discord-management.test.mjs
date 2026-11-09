import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discordChannelOperation as channels, discordMessageOperation as messages, installDiscordManagementTools } from '../plugin-src/host/discord-management.mjs';

const guildId = '1468696024829792310';
const channelId = '123456789012345678';
const parentId = '223456789012345678';
const messageId = '323456789012345678';
const channel = { id: channelId, guild_id: guildId, type: 0, name: 'general', permission_overwrites: [{ secret: true }] };
const message = { id: messageId, channel_id: channelId, content: 'hello', author: { id: '423456789012345678', username: 'tester', email: 'private' }, embeds: [{ description: 'not requested' }] };
const signal = new AbortController().signal;
const base = () => ({ async getChannel() { return channel; } });

test('channel list is hard scoped, metadata only, bounded and paginated', async () => {
  const api = { async listGuildChannels(args) {
    assert.deepEqual(args, { guildId, signal });
    return Array.from({ length: 101 }, (_, n) => ({ ...channel, id: String(n), available_tags: [{ id: 'tag', name: 'work' }] }));
  } };
  const first = await channels(api, { action: 'list' }, signal);
  assert.equal(first.channels.length, 100);
  assert.equal(first.nextOffset, 100);
  assert.equal(first.total, 101);
  assert.equal(first.channels[0].permission_overwrites, undefined);
  assert.equal(first.channels[0].available_tags[0].name, 'work');
  assert.equal((await channels(api, { action: 'list', offset: 100 }, signal)).nextOffset, null);
  await assert.rejects(channels(api, { action: 'list', guildId: 'other' }), /limited/);
  await assert.rejects(channels({ listGuildChannels: async () => [{ ...channel, guild_id: 'other' }] }, { action: 'list' }), /limited/);
});

test('all targeted channel and message operations reject foreign guilds and DMs', async () => {
  for (const foreign of ['other', undefined]) {
    const api = { getChannel: async () => ({ ...channel, guild_id: foreign }) };
    for (const action of ['inspect', 'update', 'move', 'delete']) {
      await assert.rejects(channels(api, { action, channelId, name: 'new', position: 0, confirm: true }), /limited/);
    }
    for (const action of ['read', 'get', 'send', 'edit', 'delete', 'pins', 'pin', 'unpin']) {
      await assert.rejects(messages(api, { action, channelId, messageId, content: 'hi', confirm: true }), /limited/);
    }
  }
});

test('create/update/move validate parent same guild and category before writes', async () => {
  for (const action of ['create', 'update', 'move']) {
    for (const badParent of [{ ...channel, guild_id: 'other', type: 4 }, { ...channel, type: 0 }]) {
      const api = { getChannel: async args => args.channelId === parentId ? badParent : channel };
      await assert.rejects(channels(api, { action, channelId, parentId, name: 'test', position: 0 }), /limited|category/);
    }
  }
  await assert.rejects(channels(base(), { action: 'create', name: 'nested', type: 4, parentId }), /Categories/);
  await assert.rejects(channels(base(), { action: 'move', channelId, parentId: channelId }), /own parent/);
  for (const action of ['create', 'update', 'move']) {
    const reads = [];
    const api = { getChannel: async args => {
      reads.push(args.channelId);
      return args.channelId === parentId ? { ...channel, id: parentId, type: 4 } : channel;
    } };
    const method = { create: 'createGuildChannel', update: 'updateChannel', move: 'moveChannel' }[action];
    api[method] = async args => { assert.equal(args.parentId, parentId); assert.equal(reads.at(-1), parentId); return channel; };
    await channels(api, { action, channelId, parentId, name: 'valid', position: 0 });
  }
});

test('channel creation supports types 0/2/4/15, tags and exact arguments', async () => {
  for (const type of [0, 2, 4, 15]) {
    const api = { async createGuildChannel(args) {
      assert.equal(args.guildId, guildId); assert.equal(args.type, type); assert.equal(args.signal, signal);
      assert.equal(args.name, 'new');
      return { ...channel, type, available_tags: type === 15 ? [{ id: '11111', name: 'work' }] : undefined };
    } };
    const result = await channels(api, { action: 'create', name: 'new', type }, signal);
    assert.equal(result.type, type);
  }
  await assert.rejects(channels({}, { action: 'create', name: 'bad', type: 5 }), /Supported/);
  await assert.rejects(channels({}, { action: 'create', name: 'bad', availableTags: [] }), /forum/);
});

test('null clears parent; omitted parent stays omitted, zero and empty values survive', async () => {
  const calls = [];
  const api = { ...base(), async updateChannel(args) { calls.push(args); return channel; }, async moveChannel(args) { calls.push(args); } };
  await channels(api, { action: 'update', channelId, topic: '', parentId: null, rateLimitPerUser: 0 }, signal);
  assert.deepEqual(calls.pop(), { channelId, topic: '', parentId: null, rateLimitPerUser: 0, auditReason: undefined, signal });
  await channels(api, { action: 'update', channelId, name: 'new' }, signal);
  assert.equal(Object.hasOwn(calls.pop(), 'parentId'), false);
  await channels(api, { action: 'move', channelId, parentId: null, position: 0, lockPermissions: false }, signal);
  assert.deepEqual(calls.pop(), { guildId, channelId, parentId: null, position: 0, lockPermissions: false, auditReason: undefined, signal });
  await assert.rejects(channels(api, { action: 'move', channelId, parentId, lockPermissions: true }), /Permission/);
  await assert.rejects(channels(api, { action: 'update', channelId, permission_overwrites: [] }), /Unsupported/);
});

test('channel field boundaries reject invalid topics, types and empty updates', async () => {
  const api = base();
  await assert.rejects(channels(api, { action: 'update', channelId, topic: 'x'.repeat(1025) }), /topic length/);
  await assert.rejects(channels(api, { action: 'update', channelId, availableTags: [] }), /forum/);
  await assert.rejects(channels(api, { action: 'update', channelId, type: 15 }), /create-only/);
  await assert.rejects(channels(api, { action: 'update', channelId }), /at least one/);
  await assert.rejects(channels(api, { action: 'move', channelId }), /requires position/);
  await assert.rejects(channels({ getChannel: async () => ({ ...channel, type: 11 }) }, { action: 'delete', channelId, confirm: true }), /thread tool/);
  const forumApi = { getChannel: async () => ({ ...channel, type: 15 }), updateChannel: async args => {
    assert.equal(args.topic.length, 4096); assert.deepEqual(args.availableTags, []);
    return { ...channel, type: 15, available_tags: [] };
  } };
  await channels(forumApi, { action: 'update', channelId, topic: 'x'.repeat(4096), availableTags: [] });
  await assert.rejects(messages(forumApi, { action: 'send', channelId, content: 'hello' }), /forum posts/);
});

test('deletes require strict direct-authorization confirmation and return receipts', async () => {
  let deletes = 0;
  const api = { ...base(), async deleteChannel(args) { deletes++; assert.equal(args.auditReason, 'authorized'); }, async deleteMessage(args) { deletes++; assert.equal(args.messageId, messageId); } };
  for (const confirm of [undefined, false, 'true', 1]) {
    await assert.rejects(channels(api, { action: 'delete', channelId, confirm }), /authorization/);
    await assert.rejects(messages(api, { action: 'delete', channelId, messageId, confirm }), /authorization/);
  }
  assert.equal(deletes, 0);
  assert.equal((await channels(api, { action: 'delete', channelId, confirm: true, auditReason: 'authorized' })).success, true);
  assert.equal((await messages(api, { action: 'delete', channelId, messageId, confirm: true })).success, true);
  assert.equal(deletes, 2);
});

test('read/get explicitly return content, bounded rows and cursor extrema', async () => {
  const api = { ...base(), async listMessages(args) {
    assert.equal(args.limit, 2); assert.equal(args.after, '11111'); assert.equal(args.signal, signal);
    return [{ ...message, id: '33333' }, { ...message, id: '22222' }, message];
  }, getMessage: async () => message };
  const result = await messages(api, { action: 'read', channelId, after: '11111', limit: 2 }, signal);
  assert.equal(result.messages.length, 2);
  assert.equal(result.nextBefore, '22222'); assert.equal(result.nextAfter, '33333');
  assert.equal(result.mayHaveMore, true); assert.equal(result.messages[0].content, 'hello');
  assert.equal(result.messages[0].author.email, undefined);
  assert.equal(result.messages[0].embeds, undefined);
  assert.equal((await messages(api, { action: 'get', channelId, messageId })).content, 'hello');
  for (const limit of [0, 101, 1.5]) await assert.rejects(messages(api, { action: 'read', channelId, limit }), /limit/);
  await assert.rejects(messages(api, { action: 'read', channelId, before: '11111', after: '22222' }), /mutually exclusive/);
});

test('pins use timestamp pagination, at most 50 metadata entries and has_more', async () => {
  const pinned_at = '2026-11-09T12:34:56.123456+00:00';
  const api = { ...base(), async listPins(args) {
    assert.equal(args.before, pinned_at); assert.equal(args.limit, 50);
    return { items: [{ pinned_at, message }], has_more: true };
  } };
  const result = await messages(api, { action: 'pins', channelId, before: pinned_at });
  assert.equal(result.has_more, true); assert.equal(result.nextBefore, pinned_at);
  assert.equal(result.items[0].message.content, undefined); assert.equal(result.contentOmitted, true);
  await assert.rejects(messages(api, { action: 'pins', channelId, limit: 51 }), /limit/);
  api.listPins = async () => ({ items: [], has_more: false });
  assert.equal((await messages(api, { action: 'pins', channelId })).nextBefore, null);
});

test('message writes dispatch exact API args, omit returned content and never retry', async () => {
  const calls = [];
  const api = { ...base() };
  for (const method of ['createMessage', 'editMessage', 'pinMessage', 'unpinMessage']) api[method] = async args => { calls.push([method, args]); return message; };
  for (const action of ['send', 'edit', 'pin', 'unpin']) {
    const result = await messages(api, { action, channelId, messageId, content: '@everyone test', auditReason: 'test' }, signal);
    assert.equal(result.content, undefined);
  }
  assert.deepEqual(calls[0], ['createMessage', { channelId, content: '@everyone test', signal }]);
  assert.deepEqual(calls[1], ['editMessage', { channelId, messageId, content: '@everyone test', signal }]);
  assert.deepEqual(calls[2], ['pinMessage', { channelId, messageId, auditReason: 'test', signal }]);
  assert.deepEqual(calls[3], ['unpinMessage', { channelId, messageId, auditReason: 'test', signal }]);
  await messages(api, { action: 'send', channelId, content: 'reply', replyToMessageId: messageId }, signal);
  assert.deepEqual(calls[4], ['createMessage', { channelId, content: 'reply', replyToMessageId: messageId, signal }]);
  let attempts = 0;
  api.createMessage = async () => { attempts++; throw new Error('timeout'); };
  await assert.rejects(messages(api, { action: 'send', channelId, content: 'hello' }), /timeout/);
  assert.equal(attempts, 1);
});

test('registration re-resolves credentials for every execution and sends/edits without mentions', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-management-test-'));
  const previousFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = previousFetch; await rm(home, { recursive: true, force: true }); });
  await mkdir(join(home, 'integrations/dsh-discord'), { recursive: true });
  await writeFile(join(home, 'integrations/dsh-discord/config.json'), JSON.stringify({ bots: [{ botId: 'test', tokenRef: 'test-ref' }] }));
  const tools = [];
  let resolutions = 0;
  let token;
  installDiscordManagementTools({
    inject(deps, callback) { assert.deepEqual(deps, ['tools']); callback({ tools: { register(tool) { tools.push(tool); } } }); },
    credentials: { async resolve(ref) { assert.equal(ref, 'test-ref'); token = `${String(++resolutions).repeat(25)}.aaaa.${'b'.repeat(25)}`; return { value: token }; } },
  }, { dshHome: home });
  assert.deepEqual(tools.map(t => t.name), ['dsh_discord_channel', 'dsh_discord_message']);
  for (const tool of tools) assert.equal(tool.parameters.additionalProperties, false);
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.authorization, `Bot ${token}`);
    if (options.method === 'GET') return Response.json(channel);
    assert.deepEqual(JSON.parse(options.body).allowed_mentions, { parse: [], replied_user: false });
    return Response.json(message);
  };
  await tools[0].execute({ action: 'inspect', channelId }, { signal });
  for (const action of ['send', 'edit']) {
    const result = await tools[1].execute({ action, channelId, messageId, content: '@everyone hello' }, { signal });
    assert.doesNotMatch(JSON.stringify(result), /test-ref|Bot |@everyone/);
  }
  assert.equal(resolutions, 3);
  await assert.rejects(tools[0].execute({ action: 'inspect', channelId, botId: 'missing' }, { signal }), /Specify/);
});
