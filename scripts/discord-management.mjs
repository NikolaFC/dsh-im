import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { DiscordApi } from '../src/channels/discord/discord-api.mjs';
import { discordChannelOperation, discordMessageOperation } from '../plugin-src/host/discord-management.mjs';
const require = createRequire('C:/AI/DSH/cli/package.json');
const yaml = require('yaml');
const home = process.env.DSH_HOME ?? 'C:/Users/nikol/.dsh';
const { kind, ...input } = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const { bots } = JSON.parse(await fs.readFile(`${home}/integrations/dsh-discord/config.json`, 'utf8'));
const bot = input.botId ? bots.find(b => b.botId === input.botId) : bots.length === 1 ? bots[0] : null;
if (!bot) throw new Error('Select a configured bot');
const store = yaml.parse(await fs.readFile(`${home}/.credentials.yaml`, 'utf8'));
const token = store.refs?.[bot.tokenRef] ?? process.env[bot.tokenRef];
if (!token) throw new Error('Credential not available');
try {
  const run = kind === 'channel' ? discordChannelOperation : kind === 'message' ? discordMessageOperation : null;
  if (!run) throw new Error('kind must be channel or message');
  const result = await run(new DiscordApi({token}), input, AbortSignal.timeout(30000));
  const receipt = JSON.stringify(result, null, 2);
  if (process.argv[3]) await fs.writeFile(process.argv[3], receipt);
  console.log(receipt);
} catch (e) { console.error(JSON.stringify({error:e.message,code:e.code,status:e.status})); process.exitCode=1; }
