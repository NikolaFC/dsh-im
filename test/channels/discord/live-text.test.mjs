// duoduo fork: mid-turn assistant text is posted to Discord as each step ends.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DiscordHarnessBridge } from '../../../src/channels/discord/discord-bridge.mjs';
import { DiscordConfigStore, deriveDiscordBotIdentity } from '../../../src/channels/discord/config-store.mjs';
import { DiscordBotClient } from '../../../src/channels/discord/discord-runtime.mjs';
import { HarnessReplyTracker } from '../../../src/channels/shared/harness-client.mjs';
import {
  liveSegmentsEnabled,
  registerLiveSegmentBot,
} from '../../../src/channels/shared/session-sync-registry.mjs';
import { createSessionSyncCoordinator } from '../../../plugin-src/host/session-sync-coordinator.mjs';

const PROMPT = 'live-text-prompt';

function toolStep(seq, step, text) {
  return [
    {
      type: 'assistant/message',
      seq,
      data: {
        turn: 1,
        step,
        message: { content: [
          { type: 'reasoning', text: `think ${step}` },
          ...(text ? [{ type: 'text', text }] : []),
          { type: 'tool-call', toolCallId: `call-${step}`, toolName: 'bash' },
        ] },
      },
    },
    { type: 'tool/call', seq: seq + 1, data: { turn: 1, step, callId: `call-${step}`, name: 'bash', arguments: { command: `run ${step}` } } },
  ];
}

function finalStep(seq, step, text) {
  return {
    type: 'assistant/message',
    seq,
    data: { turn: 1, step, message: { content: [{ type: 'reasoning', text: `think ${step}` }, { type: 'text', text }] } },
  };
}

/** The event shape of the turn that motivated the change (text + tool-call steps). */
function turnEvents() {
  return [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { turn: 1, source: { rpcId: PROMPT } } },
    ...toolStep(3, 0, '先说一段'),
    ...toolStep(5, 1, ''),
    ...toolStep(7, 2, '第二段播报'),
    finalStep(9, 3, '最后的答案'),
    { type: 'turn/end', seq: 10, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

test('tracker marks tool steps and leaves posted steps out of the answer', () => {
  const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT, reasoning: true });
  const updates = tracker.consumeAll(turnEvents());
  const messages = updates.filter((update) => update.type === 'assistant-message');
  assert.deepEqual(messages.map(({ step, toolCalls }) => [step, toolCalls === true]), [
    [0, true], [2, true], [3, false],
  ]);
  assert.equal(tracker.answer, '先说一段\n\n第二段播报\n\n最后的答案');
  assert.equal(tracker.answerExcluding(new Set([0, 2])), '最后的答案');
  assert.equal(tracker.answerExcluding(new Set()), tracker.answer, 'an empty set changes nothing');
  assert.equal(tracker.finalAnswerExcluding(null), tracker.answer);
});

function recordingApi({ failContent = null } = {}) {
  const calls = [];
  let next = 500;
  return {
    calls,
    async createMessage({ channelId, content, replyToMessageId }) {
      // Only the segment itself fails; the final message must still go out.
      if (failContent && content === failContent) throw new Error('discord down');
      const id = String(next += 1);
      calls.push({ op: 'create', id, channelId, content, replyToMessageId });
      return { id };
    },
    async editMessage({ channelId, messageId, content }) {
      calls.push({ op: 'edit', id: messageId, channelId, content });
      return { id: messageId };
    },
    async sendTyping() {},
  };
}

/** Final text of every Discord message, in creation order. */
function finalContents(api) {
  const byId = new Map();
  for (const call of api.calls) byId.set(call.id, call.content);
  return api.calls.filter((call) => call.op === 'create').map((call) => byId.get(call.id));
}

test('thinking stream posts a segment between trace pages, in order', async () => {
  const api = recordingApi();
  const stream = new DiscordBotClient({ api, logger: { warn() {} } })
    .openThinkingStream({ channelId: 'c1', replyToMessageId: 'm1' });
  await stream.sendThinking('先看看');
  await stream.sendToolTrace('grep', { pattern: 'x' });
  const sent = await stream.sendSegment({ kind: 'text', text: '**第一段**', format: 'markdown' });
  await stream.sendToolTrace('read', { file_path: 'a.mjs' });
  const result = await stream.finish({ kind: 'text', text: '答案', format: 'markdown' });

  assert.deepEqual(finalContents(api), [
    '-# 💭 先看看\n-# 🔧 grep → x',
    '**第一段**',
    '-# 🔧 read → a.mjs',
    '答案',
  ]);
  const creates = api.calls.filter((call) => call.op === 'create');
  assert.equal(creates[0].replyToMessageId, 'm1', 'only the first message anchors the turn');
  assert.equal(creates[1].replyToMessageId, undefined);
  assert.equal(creates[2].replyToMessageId, undefined);
  assert.deepEqual(sent.providerMessageIds, [creates[1].id]);
  assert.ok(stream.providerMessageIds.includes(creates[1].id), 'segments count as delivered messages');
  assert.deepEqual(result.providerMessageIds, [creates[3].id]);
});

test('thinking stream splits a long segment and skips the answer when everything went live', async () => {
  const api = recordingApi();
  const stream = new DiscordBotClient({ api, logger: { warn() {} } }).openThinkingStream({ channelId: 'c1' });
  await stream.sendSegment({ kind: 'text', text: `${'甲'.repeat(1_500)}\n\n${'乙'.repeat(1_500)}`, format: 'markdown' });
  const result = await stream.finish({ liveSegmentsOnly: true });
  const contents = finalContents(api);
  assert.equal(contents.length, 2, 'a 3000-character segment uses the existing 1900 split');
  for (const content of contents) assert.ok(content.length <= 2000);
  assert.deepEqual(result.providerMessageIds, [], 'no placeholder answer after live segments');

  const quiet = recordingApi();
  const empty = new DiscordBotClient({ api: quiet }).openThinkingStream({ channelId: 'c' });
  await empty.finish({ liveSegmentsOnly: true });
  assert.deepEqual(finalContents(quiet), ['处理完成。'], 'without any posted segment the old placeholder stays');
});

function stateFixture() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessionFor: (key) => sessions.get(key) ?? null,
    async setSession(key, sessionId) { sessions.set(key, sessionId); return true; },
    async clearSession(key) { sessions.delete(key); },
    hasSeen: (id) => seen.has(id),
    async markSeen(id) { seen.add(id); },
    async unmarkSeen(id) { return seen.delete(id); },
  };
}

/**
 * A Harness stub that replays the turn through the real tracker, exactly as
 * HarnessClient.ask() feeds onUpdate, and answers the way ask() does.
 */
function replayHarness(events, { stop = false } = {}) {
  const asks = [];
  return {
    asks,
    createSession: async () => 'session-live',
    async ask(_sessionId, _text, options) {
      asks.push(options);
      const tracker = new HarnessReplyTracker({ promptRpcId: PROMPT, reasoning: options.reasoning === true });
      for (const event of events) {
        for (const update of tracker.consumeAll([event])) await options.onUpdate?.(update);
      }
      const steps = options.liveDeliveredSteps;
      const answer = stop ? tracker.answerExcluding(steps) : tracker.finalAnswerExcluding(steps);
      if (answer) return answer;
      if (steps?.size > 0) return '';
      return '本轮处理已结束，没有文本回复。';
    },
  };
}

function discordBridge(api, harness, { liveText = true } = {}) {
  return new DiscordHarnessBridge({
    bot: new DiscordBotClient({ api, logger: { warn() {} } }),
    harness,
    state: stateFixture(),
    thinkingTraces: true,
    liveText,
    logger: { warn() {}, error() {}, info() {} },
  });
}

function discordMessage(id) {
  return {
    messageId: id,
    senderId: 'user-1',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chan-1',
    content: '直播一下',
    addressed: true,
    replyTarget: { channelId: 'chan-1', replyToMessageId: id },
  };
}

test('bridge posts each tool step text live and the final message carries only the rest', async () => {
  const api = recordingApi();
  const harness = replayHarness(turnEvents());
  await discordBridge(api, harness).accept(discordMessage('900'));

  assert.ok(harness.asks[0].liveDeliveredSteps instanceof Set);
  assert.deepEqual([...harness.asks[0].liveDeliveredSteps].sort(), [0, 2]);
  assert.deepEqual(finalContents(api), [
    '-# 💭 think 0',
    '先说一段',
    '-# 🔧 bash → run 0\n-# 💭 think 1\n-# 🔧 bash → run 1\n-# 💭 think 2',
    '第二段播报',
    '-# 🔧 bash → run 2\n-# 💭 think 3',
    '最后的答案',
  ]);
  const all = finalContents(api).join('\n');
  for (const text of ['先说一段', '第二段播报', '最后的答案']) {
    assert.equal(all.split(text).length - 1, 1, `${text} appears exactly once`);
  }
});

test('a stopped turn posts nothing twice and the last segment is not repeated', async () => {
  const events = turnEvents().slice(0, 8); // steps 0-2 ran, then /stop
  const api = recordingApi();
  await discordBridge(api, replayHarness(events, { stop: true })).accept(discordMessage('901'));
  const contents = finalContents(api);
  assert.equal(contents.filter((text) => text === '先说一段').length, 1);
  assert.equal(contents.filter((text) => text === '第二段播报').length, 1);
  assert.ok(!contents.some((text) => text.includes('本轮处理已结束')), 'no empty-reply placeholder');
});

test('a failed segment send keeps the text for the final message', async () => {
  const api = recordingApi({ failContent: '先说一段' });
  await discordBridge(api, replayHarness(turnEvents())).accept(discordMessage('902'));
  const finalMessage = finalContents(api).at(-1);
  assert.match(finalMessage, /先说一段/);
  assert.match(finalMessage, /最后的答案/);
  assert.doesNotMatch(finalMessage, /第二段播报/, 'the segment that did post is still excluded');
});

test('liveText=false keeps the old single final message', async () => {
  const api = recordingApi();
  const harness = replayHarness(turnEvents());
  await discordBridge(api, harness, { liveText: false }).accept(discordMessage('903'));
  assert.equal(harness.asks[0].liveDeliveredSteps, undefined);
  assert.equal(finalContents(api).at(-1), '先说一段\n\n第二段播报\n\n最后的答案');
});

test('config store keeps an explicit liveText opt-out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discord-live-'));
  try {
    const path = join(directory, 'config.json');
    const store = new DiscordConfigStore(path);
    const identity = deriveDiscordBotIdentity('1483184501986164748');
    const base = { ...identity, platformId: '1483184501986164748', name: 'bot' };
    await store.save(base);
    assert.equal(store.get(identity.botId).liveText, undefined, 'absent means ON');
    await store.save({ ...base, liveText: false });
    await store.save(base);
    assert.equal(store.get(identity.botId).liveText, false, 'a rebuild without the field keeps it');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.bots[0].liveText, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Session sync (goal rounds and other service turns).

function syncEvents(origin) {
  const toolMessage = (step, text) => ({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { turn: 3, step, message: { content: [{ type: 'text', text }, { type: 'tool-call', toolName: 'bash' }] } },
  });
  return [
    [{ type: 'turn/start', data: { turn: 3 } }, 'other'],
    [{ type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'goal' }, content: [{ type: 'text', text: 'goal' }] } }, 'other'],
    [toolMessage(0, '目标轮第一段'), 'other'],
    [{ type: 'tool/call', surfaceOp: 'append', data: { turn: 3, name: 'bash' } }, 'other'],
    [{ type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user', rpcId: 'discord-steer-1' }, content: [{ type: 'text', text: '插话' }] } }, origin],
    [toolMessage(1, '目标轮第二段'), 'other'],
    [{ type: 'tool/call', surfaceOp: 'append', data: { turn: 3, name: 'bash' } }, 'other'],
    [{ type: 'assistant/message', surfaceOp: 'append', data: { turn: 3, step: 2, message: { content: [{ type: 'text', text: '目标轮结论' }] } } }, 'other'],
    [{ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }, 'other'],
  ];
}

function bindingDelivery(sends, channel) {
  return {
    async describeConversation(sessionId) {
      return { channel, botId: `${channel}_bot`, conversationKey: `group:${sessionId}` };
    },
    async deliverSessionText(sessionId, text, options) {
      sends.push({ sessionId, text, format: options.format });
      return { sent: true };
    },
  };
}

const deliverAll = async () => ({ mirrorUserInput: false, deliverModelAnswers: true, inputIcon: '', modelIcon: '' });

test('goal rounds post tool step text live to an opted-in Discord bot, final once', async () => {
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: bindingDelivery(sends, 'discord'),
    loadSettings: deliverAll,
    liveSegments: (target) => target.channel === 'discord',
  });
  for (const [event, origin] of syncEvents('im-steer')) void coordinator.enqueue('session-goal', event, origin);
  await coordinator.whenIdle();
  assert.deepEqual(sends.map((entry) => entry.text), ['目标轮第一段', '目标轮第二段', '目标轮结论']);
  assert.ok(sends.every((entry) => entry.format === 'markdown'));
});

test('a chat steer does not claim a goal round; a non-live bot keeps final-only', async () => {
  const sends = [];
  const coordinator = createSessionSyncCoordinator({
    deliveryService: bindingDelivery(sends, 'feishu'),
    loadSettings: deliverAll,
    liveSegments: (target) => target.channel === 'discord',
  });
  for (const [event, origin] of syncEvents('im-steer')) void coordinator.enqueue('session-goal-2', event, origin);
  await coordinator.whenIdle();
  assert.deepEqual(sends.map((entry) => entry.text), ['目标轮结论'], 'steered goal round is still delivered, without segments');

  // A real chat prompt (not a steer) still means the chat answers the turn itself.
  const claimed = [];
  const owned = createSessionSyncCoordinator({
    deliveryService: bindingDelivery(claimed, 'discord'),
    loadSettings: deliverAll,
    liveSegments: () => true,
  });
  for (const [event, origin] of syncEvents('im')) void owned.enqueue('session-goal-3', event, origin);
  await owned.whenIdle();
  assert.deepEqual(claimed.map((entry) => entry.text), ['目标轮第一段'], 'only what was posted before the chat claimed the turn');
});

test('live segment registry only answers for the registered bot', () => {
  const dispose = registerLiveSegmentBot({ channel: 'discord', botId: 'discord_a' });
  try {
    assert.equal(liveSegmentsEnabled({ channel: 'discord', botId: 'discord_a' }), true);
    assert.equal(liveSegmentsEnabled({ channel: 'discord', botId: 'discord_b' }), false);
    assert.equal(liveSegmentsEnabled({ channel: 'telegram', botId: 'discord_a' }), false);
    assert.equal(liveSegmentsEnabled(null), false);
  } finally {
    dispose();
  }
  assert.equal(liveSegmentsEnabled({ channel: 'discord', botId: 'discord_a' }), false);
});
