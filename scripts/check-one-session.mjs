import { pathToFileURL } from 'node:url';
const recall = await import(pathToFileURL('C:/AI/DSH/tools/session-recall/recall.mjs').href);
const f='C:/Users/nikol/.dsh/sessions/--C-AI--/session-81863e1d-9540-4946-8872-a751f420013b/session.v4.jsonl.zstd';
const rows = recall.decodeSessionFile(f);
console.log(JSON.stringify(rows.filter(r=>r.type==='session/title').map(r=>r.data)));
console.log(JSON.stringify(rows.filter(r=>r.type==='agent/inbox/spliced').map(r=>({seq:r.seq, data:JSON.stringify(r.data).slice(0,200)})).slice(0,6)));
