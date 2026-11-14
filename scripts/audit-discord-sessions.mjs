import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
const recall = await import(pathToFileURL('C:/AI/DSH/tools/session-recall/recall.mjs').href);
const files = recall.listSessionFiles('C:/Users/nikol/.dsh/sessions');
const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
const out = [];
for (const f of files) {
  let st;
  try { st = fs.statSync(f); } catch { continue; }
  if (st.mtimeMs < cutoff) continue;
  let rows;
  try { rows = recall.decodeSessionFile(f); } catch { continue; }
  const isDiscord = rows.some(r => r.type === 'user/message'
    && JSON.stringify(r.data?.source ?? {}).includes('"rpcId":"discord-'));
  if (!isDiscord) continue;
  const titles = rows.filter(r => r.type === 'session/title').map(r => r.data?.title);
  const presets = new Set();
  const targets = new Set();
  const answers = [];
  const models = new Set();
  for (const r of rows) {
    if (r.type === 'permission/preset') presets.add(r.data?.preset);
    if (r.type === 'agent/inbox/spliced' && r.data?.target) targets.add(r.data.target);
    if (r.type === 'request/header' && r.data?.header?.config?.model) models.add(r.data.header.config.model);
    if (r.type === 'tool/result') {
      const m = JSON.stringify(r.data).match(/\{"answers".{0,200}/);
      if (m) answers.push(m[0]);
    }
  }
  out.push({
    session: path.basename(path.dirname(f)).slice(0, 26),
    title: titles.at(-1), lastWrite: st.mtime.toISOString().slice(0, 16),
    presets: [...presets], spliceTargets: [...targets], models: [...models], answers: answers.slice(-4),
  });
}
console.log(JSON.stringify(out, null, 1));
