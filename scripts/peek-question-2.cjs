const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('C:/Users/nikol/.dsh/integrations/dsh-im/group-history.sqlite', {readOnly:true});
const rows = db.prepare("SELECT platform_message_id, sender_name, sent_at, type, substr(text,1,40) t FROM messages WHERE sent_at > 1794259100000 ORDER BY sent_at ASC").all();
console.log(JSON.stringify(rows, null, 1));
