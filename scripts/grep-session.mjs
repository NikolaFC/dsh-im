import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import zlib from 'node:zlib';
const path = process.argv[2];
const needle = process.argv[3];
const raw = await fs.readFile(path);
const text = zlib.zstdDecompressSync(raw).toString('utf8');
const lines = text.split('\n');
console.log(JSON.stringify({ lines: lines.length }));
let shown = 0;
for (const line of lines) {
  if (!line.includes(needle)) continue;
  console.log(line.slice(0, 1200));
  if (++shown >= 12) break;
}
