import { pathToFileURL } from 'node:url';
const recall = await import(pathToFileURL('C:/AI/DSH/tools/session-recall/recall.mjs').href);
const f='C:/Users/nikol/.dsh/sessions/--C-AI--/session-3fbf36f9-fbcb-47c4-9f6e-60f6a0d4b458/session.v4.jsonl.zstd';
const rows = recall.decodeSessionFile(f);
const idx = rows.findIndex(r=>r.seq===504);
console.log(JSON.stringify(rows.slice(Math.max(0,idx-6), idx+4).map(r=>({seq:r.seq,type:r.type, snippet:JSON.stringify(r.data).slice(0,110)})), null, 1));
