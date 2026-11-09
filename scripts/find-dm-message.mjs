import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire('C:/AI/DSH/cli/package.json');
const yaml=require('yaml');
const home=process.env.DSH_HOME ?? 'C:/Users/nikol/.dsh';
const bot=JSON.parse(await fs.readFile(`${home}/integrations/dsh-discord/config.json`,'utf8')).bots[0];
const token=yaml.parse(await fs.readFile(`${home}/.credentials.yaml`,'utf8')).refs[bot.tokenRef];
const auth={authorization:`Bot ${token}`};
const dms=await (await fetch('https://discord.com/api/v10/users/@me/channels',{headers:auth})).json();
const target=process.argv[2];
for (const dm of dms) {
  const r=await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages/${target}`,{headers:auth});
  if (!r.ok) continue;
  const m=await r.json();
  console.log(JSON.stringify({channelId:dm.id, id:m.id, hasComponents:(m.components??[]).length>0, components:m.components}, null, 1));
  process.exit(0);
}
console.log(JSON.stringify({found:false, dmChannels:dms.length}));
