const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('C:/Users/nikol/.dsh/integrations/dsh-im/group-history.sqlite', {readOnly:true});
const cols = db.prepare('PRAGMA table_info(messages)').all().map(c=>c.name);
const rows = db.prepare('SELECT * FROM messages ORDER BY sent_at DESC LIMIT 8').all();
console.log(JSON.stringify({cols, rows}, null, 1).slice(0, 3000));
