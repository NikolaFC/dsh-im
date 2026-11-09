// Tests for the duoduo fork: mention-free routing and the Discord thinking-trace stream.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DiscordConfigStore, deriveDiscordBotIdentity } from '../../../src/channels/discord/config-store.mjs';
import {
  DiscordBotClient,
  discordTraceLine,
  normalizeDiscordMessage,
  resolveDiscordMessageRoute,
} from '../../../src/channels/discord/discord-runtime.mjs';

const botId = '1234567890123456789';
const guildMessage = (overrides = {}) => ({
  id: '111111111111111101',
  channel_id: '222222222222222201',
  guild_id: '444444444444444444',
  author: { id: '333333333333333333', bot: false },
  mentions: [],
  content: 'no mention here',
  ...overrides,
});

test('fork: mention-free bots treat every guild message as addressed', () => {
  assert.equal(normalizeDiscordMessage(guildMessage(), botId).addressed, false);
  assert.equal(normalizeDiscordMessage(guildMessage(), botId, { mentionFree: true }).addressed, true);
});

test('fork: mention-free routing replies in place and never opens a Thread', async () => {
  const message = guildMessage();
  const api = {
    async getChannel() { return { id: message.channel_id, type: 0 }; },
    async startThreadFromMessage() { assert.fail('mention-free routing must not create a Thread'); },
    async startThread() { assert.fail('mention-free routing must not create a Thread'); },
  };
  const route = await resolveDiscordMessageRoute(message, botId, { api, mentionFree: true });
  assert.equal(route.addressed, true);
  assert.equal(route.requiresMention, false);
  assert.equal(route.conversationId, message.channel_id);
  assert.deepEqual(route.replyTarget, { channelId: message.channel_id, replyToMessageId: message.id });
  assert.deepEqual(route.conversationRoute, { peerId: message.channel_id });

  const thread = await resolveDiscordMessageRoute(
    guildMessage({ id: '111111111111111102', channel_id: '222222222222222202' }),
    botId,
    { api: { async getChannel() { return { id: '222222222222222202', type: 11, parent_id: '9', owner_id: '1' }; } }, mentionFree: true },
  );
  assert.equal(thread.requiresMention, false, 'a foreign thread needs no mention either');
});

test('fork: trace lines are Discord subtext with markdown neutralized', () => {
  assert.equal(discordTraceLine('🔧 grep → a*b_c'), '-# 🔧 grep → a\\*b\\_c');
  assert.equal(discordTraceLine('-flag `x` [l](u)'), '-# \\-flag \\`x\\` \\[l\\]\\(u\\)');
});

function recordingApi() {
  const calls = [];
  let next = 900;
  return {
    calls,
    async createMessage({ channelId, content, replyToMessageId }) {
      const id = String(next += 1);
      calls.push({ op: 'create', id, channelId, content, replyToMessageId });
      return { id };
    },
    async editMessage({ channelId, messageId, content }) {
      calls.push({ op: 'edit', id: messageId, channelId, content });
      return { id: messageId };
    },
  };
}

test('fork: thinking stream keeps one edited trace message, then a separate answer', async () => {
  const api = recordingApi();
  const client = new DiscordBotClient({ api, logger: { warn() {} } });
  const target = { channelId: 'c1', replyToMessageId: 'm1' };
  const stream = client.openThinkingStream(target);
  assert.equal(typeof stream.sendToolTrace, 'function');
  assert.equal(stream.keepalive, true);

  await stream.sendThinking('先查一下插件。\n\n第二段不显示');
  await stream.sendToolTrace('grep', { pattern: 'discord' });
  await stream.sendToolTrace('read', { file_path: 'C:/x.mjs' });
  const result = await stream.finish({ kind: 'text', text: '**答案**', format: 'markdown' });

  const creates = api.calls.filter((call) => call.op === 'create');
  assert.equal(creates.length, 2, 'one trace message plus one answer');
  assert.equal(creates[0].replyToMessageId, 'm1');
  assert.equal(creates[0].content, '-# 💭 先查一下插件。');
  const lastTrace = api.calls.filter((call) => call.id === creates[0].id).at(-1);
  assert.equal(lastTrace.content, [
    '-# 💭 先查一下插件。',
    '-# 🔧 grep → discord',
    '-# 🔧 read → C:/x.mjs',
  ].join('\n'));
  assert.equal(api.calls.at(-1).content, '**答案**', 'the answer is last and keeps its markdown');
  assert.deepEqual(stream.providerMessageIds, [creates[0].id]);
  assert.deepEqual(result.providerMessageIds, [creates[1].id]);
  assert.equal(result.presentation, 'discord-thinking');
});

test('fork: a turn without traces sends only the answer; a full page rolls over', async () => {
  const quiet = recordingApi();
  const quietStream = new DiscordBotClient({ api: quiet }).openThinkingStream({ channelId: 'c' });
  await quietStream.finish('已停止。');
  assert.deepEqual(quiet.calls.map((call) => call.content), ['已停止。']);

  const busy = recordingApi();
  const stream = new DiscordBotClient({ api: busy, logger: { warn() {} } }).openThinkingStream({ channelId: 'c' });
  for (let index = 0; index < 30; index += 1) {
    await stream.sendToolTrace('bash', { command: `${index} ${'x'.repeat(100)}` });
  }
  await stream.finish('done');
  const pages = new Map();
  for (const call of busy.calls) if (call.content !== 'done') pages.set(call.id, call.content);
  assert.ok(pages.size >= 2, 'the trace spills onto a second page');
  for (const content of pages.values()) assert.ok(content.length <= 2000);
  const lines = [...pages.values()].flatMap((content) => content.split('\n'));
  assert.equal(lines.length, 30, 'no trace line is lost across pages');
  assert.equal(busy.calls.at(-1).content, 'done');
});

test('fork: config store keeps explicit opt-outs and omits defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discord-fork-'));
  try {
    const path = join(directory, 'config.json');
    const store = new DiscordConfigStore(path);
    const identity = deriveDiscordBotIdentity('1483184501986164748');
    const base = { ...identity, platformId: '1483184501986164748', name: 'bot' };
    await store.save({ ...base, thinkingTraces: false });
    assert.equal(store.get(identity.botId).thinkingTraces, false);
    assert.equal(store.get(identity.botId).mentionFree, undefined);
    await store.save(base);
    assert.equal(store.get(identity.botId).thinkingTraces, false, 'a rebuild without the field keeps it');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.bots[0].thinkingTraces, false);
    assert.equal('mentionFree' in saved.bots[0], false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
