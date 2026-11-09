import { pathToFileURL } from 'node:url';
const { decodeSessionFile } = await import(pathToFileURL('C:/AI/DSH/tools/session-recall/recall.mjs').href);
const rows = decodeSessionFile('C:/Users/nikol/.dsh/sessions/--C-AI--/session-81863e1d-9540-4946-8872-a751f420013b/session.v4.jsonl.zstd');
for (const r of rows) {
  if (r.seq < 55 || r.seq > 70) continue;
  const snippet = r.type === 'user/message' ? JSON.stringify(r.data).slice(0, 260) : '';
  console.log(r.seq, r.type, snippet);
}
