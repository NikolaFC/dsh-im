import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DiscordApi } from '../../../src/channels/discord/discord-api.mjs';
import { DiscordBotClient } from '../../../src/channels/discord/discord-runtime.mjs';
import { OutboundArtifactRegistry } from '../../../src/channels/shared/semantic/artifact.mjs';
import { deliverOutboundArtifacts } from '../../../src/channels/shared/semantic/artifact-delivery.mjs';

const target = { channelId: '123456789012345678', replyToMessageId: '234567890123456789' };

function recordingApi(calls) {
  return new DiscordApi({
    token: `${'offline'.repeat(4)}.test.${'fixture'.repeat(4)}`,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ id: String(345678901234567890n + BigInt(calls.length)) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
}

test('Discord final delivery preserves short native Markdown and disables mentions', async () => {
  const calls = [];
  const client = new DiscordBotClient({ api: recordingApi(calls) });
  const text = '# Heading\n**bold** *italic* ~~strike~~ ||spoiler||\n> quote\n- list\n[link](https://example.com)\n```js\nconst x = "@everyone";\n```';
  await client.sendDelivery(target, { kind: 'text', format: 'markdown', text });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.content, text);
  assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: false });
  assert.equal(body.message_reference.message_id, target.replyToMessageId);
});

test('Discord long final delivery closes each code fence and retains every Unicode row once', async () => {
  const calls = [];
  const client = new DiscordBotClient({ api: recordingApi(calls) });
  const rows = Array.from({ length: 240 }, (_, index) => `const row_${index} = "中文😀";`);
  await client.sendDelivery(target, { kind: 'text', format: 'markdown', text: '```js\n' + rows.join('\n') + '\n```' });
  assert.ok(calls.length > 1);
  const bodies = calls.map(call => JSON.parse(call.options.body));
  for (const [index, body] of bodies.entries()) {
    assert.ok(body.content.length <= 1900);
    assert.ok(body.content.startsWith('```js\n'));
    assert.ok(body.content.endsWith('\n```'));
    assert.equal(body.content.isWellFormed(), true);
    assert.equal(body.message_reference?.message_id, index === 0 ? target.replyToMessageId : undefined);
  }
  const combined = bodies.map(body => body.content).join('\n');
  for (const row of rows) assert.equal(combined.split(row).length - 1, 1);
});

test('Discord attachment API preserves an explicitly typed video without external IO', async () => {
  const calls = [];
  const bytes = Buffer.from('synthetic offline video transport fixture');
  await recordingApi(calls).createFileMessage({ ...target, file: {
    fileName: 'sample.mp4', mediaType: 'video/mp4', bytes, deliveryKey: 'offline-video',
  } });
  const form = calls[0].options.body;
  const file = form.get('files[0]');
  assert.equal(file.name, 'sample.mp4');
  assert.equal(file.type, 'video/mp4');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  assert.deepEqual(JSON.parse(form.get('payload_json')).attachments, [{ id: 0, filename: 'sample.mp4' }]);
});

test('registered documents, images and video bytes reach Discord multipart through shared delivery', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-im-discord-media-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const registry = new OutboundArtifactRegistry();
  t.after(() => registry.clear());
  const session = { header: { id: 'offline-media-session', cwd: workspace }, events: [] };
  const close = registry.openConsumer(session.header.id, 'offline-media-rpc');
  t.after(close);
  for (const event of [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { rpcId: 'offline-media-rpc' } } },
  ]) registry.observeSessionEvent(session, event);
  const expectedTypes = {
    'report.pdf': 'application/pdf', 'picture.png': 'image/png', 'animation.gif': 'image/gif',
    'clip.mp4': 'video/mp4', 'clip.webm': 'video/webm', 'clip.MOV': 'video/quicktime',
    'clip.m4v': 'video/x-m4v', 'sound.mp3': 'audio/mpeg', 'sound.m4a': 'audio/mp4',
    'sound.aac': 'audio/aac', 'sound.wav': 'audio/wav', 'sound.ogg': 'audio/ogg',
    'sound.opus': 'audio/ogg', 'sound.flac': 'audio/flac', 'unknown.bin': 'application/octet-stream',
  };
  const fixtures = Object.keys(expectedTypes);
  for (const fileName of fixtures) {
    await writeFile(join(workspace, fileName), `offline transport fixture: ${fileName}`);
    registry.commit(await registry.stage({ path: fileName }, { agent: { session } }));
  }
  const calls = [];
  const client = new DiscordBotClient({ api: recordingApi(calls) });
  const result = await deliverOutboundArtifacts({
    artifacts: registry.take(session.header.id, 1), channelKey: 'discord',
    sendFile: file => client.sendFile(target, file),
  });
  assert.equal(result.artifactsSent, fixtures.length);
  assert.equal(result.artifactSendErrors, 0);
  assert.equal(result.receipt.providerMessageIds.length, fixtures.length);
  for (const [index, fileName] of fixtures.entries()) {
    const form = calls[index].options.body;
    const file = form.get('files[0]');
    assert.equal(file.name, fileName);
    assert.equal(file.type, expectedTypes[fileName]);
    assert.equal(await file.text(), `offline transport fixture: ${fileName}`);
    assert.equal(JSON.parse(form.get('payload_json')).message_reference.message_id, target.replyToMessageId);
  }
  assert.equal(calls[0].options.body.get('files[0]').type, 'application/pdf');
  assert.equal(calls[1].options.body.get('files[0]').type, 'image/png');
  assert.equal(calls[2].options.body.get('files[0]').type, 'image/gif');
  // Synthetic bytes prove transport and MIME inference, not media playback.
});
