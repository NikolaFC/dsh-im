import { after } from 'node:test';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const keep = setInterval(() => {}, 1000);
after(() => clearInterval(keep));
const skip = new Set(['status-reaction.test.mjs', 'text-harness-bridge.test.mjs']);
for (const d of ['test/channels/discord', 'test/channels/shared']) {
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.test.mjs') || skip.has(f)) continue;
    try { await import(pathToFileURL(resolve(d, f)).href); }
    catch (e) { console.error('LOAD_FAIL', d, f, e.message); }
  }
}
