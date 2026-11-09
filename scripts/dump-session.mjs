import fs from 'node:fs/promises';
import zlib from 'node:zlib';
const file = process.argv[2];
const needle = process.argv[3] ?? '';
const buf = await fs.readFile(file);
const text = zlib.zstdDecompressSync(buf).toString('utf8');
const lines = text.split('\n').filter(Boolean);
console.log(JSON.stringify({ lines: lines.length }));
for (const line of lines) {
  if (!line.includes(needle)) continue;
  console.log(line.slice(0, 1500));
}
