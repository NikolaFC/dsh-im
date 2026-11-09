import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire('C:/AI/DSH/cli/package.json');
const yaml=require('yaml');
const home=process.env.DSH_HOME ?? 'C:/Users/nikol/.dsh';
const bot=JSON.parse(await fs.readFile(`${home}/integrations/dsh-discord/config.json`,'utf8')).bots[0];
const token=yaml.parse(await fs.readFile(`${home}/.credentials.yaml`,'utf8')).refs[bot.tokenRef];
const auth={authorization:`Bot ${token}`};
const channelId=process.argv[2];
const limit=process.argv[3] ?? '12';
const rows=await (await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`,{headers:auth})).json();
for (const m of rows.reverse()) {
  console.log(JSON.stringify({
    id:m.id, author:m.author?.username, at:m.timestamp,
    components:(m.components??[]).length,
    componentKinds:(m.components??[]).map(c=>({type:c.type, inner:(c.components??[]).map(i=>i.type)})),
    content:(m.content??'').slice(0,60),
  }));
}
