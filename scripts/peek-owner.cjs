const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('C:/Users/nikol/.dsh/integrations/dsh-im/group-history.sqlite', {readOnly:true});
const rows = db.prepare("SELECT sender_id, sender_name, sent_at, substr(text,1,80) AS t FROM messages WHERE sender_id != '1483184501986164748' ORDER BY sent_at DESC LIMIT 10").all();
console.log(JSON.stringify(rows));
