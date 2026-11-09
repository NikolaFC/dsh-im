const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('C:/Users/nikol/.dsh/integrations/dsh-im/group-history.sqlite', {readOnly:true});
const rows = db.prepare("SELECT group_id, sender_name, sent_at, substr(text,1,300) AS t FROM messages WHERE sent_at > 1794253000000 ORDER BY sent_at ASC LIMIT 20").all();
console.log(JSON.stringify(rows, null, 1));
