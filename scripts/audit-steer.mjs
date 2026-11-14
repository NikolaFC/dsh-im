import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
const recall = await import(pathToFileURL('C:/AI/DSH/tools/session-recall/recall.mjs').href);
const files = recall.listSessionFiles('C:/Users/nikol/.dsh/sessions');
const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
const hits = [];
for (const f of files) {
  let st;
  try { st = fs.statSync(f); } catch { continue; }
  if (st.mtimeMs < cutoff) continue;
  let rows;
  try { rows = recall.decodeSessionFile(f); } catch { continue; }
  for (const r of rows) {
    if (r.type !== 'agent/inbox/spliced' || r.data?.target !== 'next-step') continue;
    for (const item of r.data?.inserted ?? []) {
      const src = JSON.stringify(item?.source ?? {});
      if (!src.includes('"rpcId":"discord-')) continue;
      const text = (item?.content ?? []).map(c => c.text ?? '').join(' ').slice(0, 90);
      hits.push({ session: path.basename(path.dirname(f)).slice(0, 26), seq: r.seq, text });
    }
  }
}
console.log(JSON.stringify({ count: hits.length, hits: hits.slice(0, 15) }, null, 1));
