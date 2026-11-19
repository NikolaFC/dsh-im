import assert from 'node:assert/strict';
import test from 'node:test';

import { DiscordApi } from '../../../src/channels/discord/discord-api.mjs';
import { DiscordBotClient } from '../../../src/channels/discord/discord-runtime.mjs';
import { classifyDiscordTypingError } from '../../../src/channels/discord/typing-error.mjs';

const token = 'aaaaaaaaaaaaaaaaaaaa.aaaa.bbbbbbbbbbbbbbbbbbbb';
const target = { channelId: '123456789012345' };
const otherTarget = { channelId: '987654321098765' };

test('Discord typing POST accepts 204 and classifies HTTP failures without raw metadata', async () => {
  const privateMessage = `private diagnostic text for ${target.channelId} using ${token}`;
  const replies = [
    new Response(null, { status: 204 }),
    Response.json({ code: 50013, message: privateMessage }, { status: 403 }),
    Response.json({ code: 10003, message: privateMessage }, { status: 404 }),
    Response.json({ code: privateMessage, message: privateMessage }, { status: 403 }),
  ];
  const api = new DiscordApi({ token, fetchImpl: async (url, options) => {
    assert.equal(url.pathname, `/api/v10/channels/${target.channelId}/typing`);
    assert.equal(options.method, 'POST');
    assert.equal(options.body, undefined);
    return replies.shift();
  } });
  assert.equal(await api.sendTyping(target), null);
  for (const details of [
    { kind: 'http', status: 403, providerCode: 50013 },
    { kind: 'http', status: 404, providerCode: 10003 },
    { kind: 'http', status: 403 },
  ]) {
    await assert.rejects(api.sendTyping(target), (error) => {
      assert.deepEqual(classifyDiscordTypingError(error), details);
      return true;
    });
  }
});

test('Discord typing classifies timeouts, cancellation and nested network codes safely', async () => {
  const privateMessage = `private diagnostic text for ${target.channelId} using ${token}`;
  for (const [failure, expected] of [
    [new TypeError(privateMessage, { cause: Object.assign(new Error(privateMessage), { code: 'ENOTFOUND' }) }),
      { kind: 'network', code: 'ENOTFOUND' }],
    [new TypeError(privateMessage, { cause: Object.assign(new Error(privateMessage), { code: privateMessage }) }),
      { kind: 'network' }],
    [new DOMException(privateMessage, 'TimeoutError'), { kind: 'timeout' }],
    [new DOMException(privateMessage, 'AbortError'), { kind: 'abort' }],
  ]) {
    const api = new DiscordApi({ token, fetchImpl: async () => { throw failure; } });
    await assert.rejects(api.sendTyping(target), (error) => {
      assert.deepEqual(classifyDiscordTypingError(error), expected);
      return true;
    });
  }
  assert.deepEqual(classifyDiscordTypingError(new Error(privateMessage)), { kind: 'unknown' });
});

test('Discord typing shares Retry-After from response time and keeps unexpired gates across channels', async () => {
  let time = 1_000;
  const calls = [];
  const api = new DiscordApi({ token, fetchImpl: async (url) => {
    calls.push(url.pathname);
    if (calls.length !== 1) return new Response(null, { status: 204 });
    time = 4_000;
    return Response.json({ code: 123, retry_after: 8 }, { status: 429, headers: { 'Retry-After': '9.0001' } });
  } });
  const client = new DiscordBotClient({ api, now: () => time });
  await assert.rejects(client.sendTyping(target), (error) => {
    assert.deepEqual(classifyDiscordTypingError(error),
      { kind: 'http', status: 429, providerCode: 123, retryAfterMs: 9_001 });
    return true;
  });
  assert.equal(calls.length, 1);

  const deferred = { sent: false, lastPulseAt: 1_000, nextPulseAt: 13_001 };
  time = 8_500;
  assert.deepEqual(await client.sendActivityTyping(target), deferred);
  await client.sendActivityTyping(otherTarget);
  time = 13_000;
  assert.deepEqual(await client.sendTyping(target), deferred);
  assert.equal(calls.length, 2);
  time = 13_001;
  assert.deepEqual(await client.sendActivityTyping(target), { sent: true, lastPulseAt: time });
  assert.equal(calls.length, 3);
});

test('Discord typing keeps a header-only 429 and never resends after cancellation', async () => {
  const abort = new AbortController();
  let time = 1_000;
  let calls = 0;
  const api = new DiscordApi({ token, fetchImpl: async () => {
    calls += 1;
    return new Response('unstructured response', { status: 429, headers: { 'Retry-After': '60' } });
  } });
  const client = new DiscordBotClient({ api, signal: abort.signal, now: () => time });
  await assert.rejects(client.sendActivityTyping(target), (error) => {
    assert.deepEqual(classifyDiscordTypingError(error), { kind: 'http', status: 429, retryAfterMs: 60_000 });
    return true;
  });
  abort.abort();
  time += 60_000;
  await assert.rejects(client.sendTyping(target), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('Discord typing handles out-of-range Retry-After without scheduling an early pulse', async () => {
  const rateLimit = { status: 429, retryAfter: Number.MAX_VALUE };
  let time = 1_000;
  const client = new DiscordBotClient({ api: { async sendTyping() { throw rateLimit; } }, now: () => time });
  await assert.rejects(client.sendTyping(target), (error) => error === rateLimit);
  time += 1_000_000;
  assert.deepEqual(await client.sendActivityTyping(target),
    { sent: false, lastPulseAt: 1_000, nextPulseAt: Number.MAX_SAFE_INTEGER });
  for (const retryAfter of [-1, NaN, Infinity, '9']) {
    assert.deepEqual(classifyDiscordTypingError({ status: 429, retryAfter }), { kind: 'http', status: 429 });
  }
});
