import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { DiscordApi } from '../src/channels/discord/discord-api.mjs';
import { syncDiscordCommands } from '../src/channels/discord/discord-interactions.mjs';
const require = createRequire('C:/AI/DSH/cli/package.json');
const yaml = require('yaml');
const home = process.env.DSH_HOME ?? 'C:/Users/nikol/.dsh';
const bot = JSON.parse(await fs.readFile(`${home}/integrations/dsh-discord/config.json`, 'utf8')).bots[0];
const token = yaml.parse(await fs.readFile(`${home}/.credentials.yaml`, 'utf8')).refs[bot.tokenRef];
const keepalive = setInterval(() => {}, 1000);
try {
  console.log(JSON.stringify(await syncDiscordCommands(new DiscordApi({ token }), bot.platformId, AbortSignal.timeout(60000))));
} catch (error) {
  console.log(JSON.stringify({ code: error.code, status: error.status, providerCode: error.providerCode, retryAfter: error.retryAfter }));
  process.exitCode = 1;
} finally {
  clearInterval(keepalive);
}
