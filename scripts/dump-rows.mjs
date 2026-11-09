import { pathToFileURL } from 'node:url';
const { decodeSessionFile } = await import(pathToFileURL('C:/AI/DSH/tools/session-recall/recall.mjs').href);
const rows = decodeSessionFile('C:/Users/nikol/.dsh/sessions/--C-AI--/session-81863e1d-9540-4946-8872-a751f420013b/session.v4.jsonl.zstd');
console.log(JSON.stringify({rows: rows.length, types: [...new Set(rows.map(r=>r.type))].slice(0,30)}));
for (const r of rows) {
  const s = JSON.stringify(r);
  if (s.includes('"question') || s.includes('海豚')) console.log(s.slice(0, 700));
}
