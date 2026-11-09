const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('C:/Users/nikol/.dsh/integrations/dsh-im/group-history.sqlite', {readOnly:true});
const n = db.prepare('SELECT COUNT(*) c, MAX(sent_at) m FROM messages').get();
const recent = db.prepare('SELECT sender_name, sent_at, substr(text,1,60) t FROM messages ORDER BY sent_at DESC LIMIT 5').all();
console.log(JSON.stringify({n, recent}, null, 1));
