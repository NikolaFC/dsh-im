const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('C:/Users/nikol/.dsh/integrations/dsh-im/group-history.sqlite', {readOnly:true});
const rows = db.prepare("SELECT group_id, platform_message_id, sender_name, sent_at, substr(text,1,160) AS t FROM messages WHERE sent_at BETWEEN 1794251850000 AND 1794252050000 ORDER BY sent_at ASC").all();
console.log(JSON.stringify(rows, null, 1));
