const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('C:/Users/nikol/.dsh/integrations/dsh-im/group-history.sqlite', {readOnly:true});
const rows = db.prepare("SELECT sender_name, sent_at, substr(text,1,110) t FROM messages WHERE text LIKE '%批准%' OR text LIKE '%当前模型%' OR text LIKE '%已切换%' OR text LIKE '%approve%' ORDER BY sent_at DESC LIMIT 12").all();
console.log(JSON.stringify(rows, null, 1));
