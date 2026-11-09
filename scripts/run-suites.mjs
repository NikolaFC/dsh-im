import { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const keep = setInterval(() => {}, 1000);
after(() => clearInterval(keep));
for (const f of process.argv.slice(2)) await import(pathToFileURL(resolve(f)).href);
