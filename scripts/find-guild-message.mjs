import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire('C:/AI/DSH/cli/package.json');
const yaml=require('yaml');
const home=process.env.DSH_HOME ?? 'C:/Users/nikol/.dsh';
const bot=JSON.parse(await fs.readFile(`${home}/integrations/dsh-discord/config.json`,'utf8')).bots[0];
const token=yaml.parse(await fs.readFile(`${home}/.credentials.yaml`,'utf8')).refs[bot.tokenRef];
const auth={authorization:`Bot ${token}`};
const get=async path=>(await fetch(`https://discord.com/api/v10${path}`,{headers:auth})).json();
const guild='1468696024829792310';
const targets=process.argv.slice(2);
const channels=await get(`/guilds/${guild}/channels`);
const active=await get(`/guilds/${guild}/threads/active`);
const ids=[...channels.map(c=>c.id), ...(active.threads??[]).map(t=>t.id)];
for (const channelId of ids) {
  for (const id of targets) {
    const r=await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${id}`,{headers:auth});
    if (!r.ok) continue;
    const m=await r.json();
    console.log(JSON.stringify({channelId, id, hasComponents:(m.components??[]).length>0, components:m.components, content:m.content.slice(0,80)}, null, 1));
  }
}
console.log(JSON.stringify({scanned: ids.length}));
