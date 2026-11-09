import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {DiscordApi} from '../src/channels/discord/discord-api.mjs';
const require=createRequire('C:/AI/DSH/cli/package.json');
const yaml=require('yaml');
const home=process.env.DSH_HOME ?? 'C:/Users/nikol/.dsh';
const bot=JSON.parse(await fs.readFile(`${home}/integrations/dsh-discord/config.json`,'utf8')).bots[0];
const token=yaml.parse(await fs.readFile(`${home}/.credentials.yaml`,'utf8')).refs[bot.tokenRef];
const api=new DiscordApi({token});
const ids=process.argv.slice(2);
for (const id of ids) {
  const channelId='1569430868370395218';
  const m=await api.getMessage({channelId, messageId:id, signal:AbortSignal.timeout(15000)});
  console.log(JSON.stringify({id, hasComponents: Array.isArray(m.components) && m.components.length>0, components: m.components}, null, 1));
}
