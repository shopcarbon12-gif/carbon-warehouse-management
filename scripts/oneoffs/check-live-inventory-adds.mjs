import fs from "fs"; import path from "path"; import pg from "pg"; import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url)); const root = path.join(__dirname,"..","..");
function loadEnvFile(rel){const p=path.join(root,rel);if(!fs.existsSync(p))return;let t=fs.readFileSync(p,"utf8");if(t.charCodeAt(0)===0xfeff)t=t.slice(1);for(const line of t.split(/\r?\n/)){const s=line.trim();if(!s||s.startsWith("#"))continue;const i=s.indexOf("=");if(i<=0)continue;const k=s.slice(0,i).trim();if(k!=="DATABASE_URL"||process.env.DATABASE_URL)continue;let v=s.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env.DATABASE_URL=v;}}
if(!process.env.DATABASE_URL)loadEnvFile(".env.coolify.local");
const c=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false});
async function q(l,sql){try{const r=await c.query(sql);console.log(`\n=== ${l} ===`);console.table(r.rows);}catch(e){console.log(`\n=== ${l} === ERR: ${e.message}`);}}
await c.connect();
await q("server clock", `SELECT now() AS db_now`);
await q("cdm_reads columns", `SELECT column_name FROM information_schema.columns WHERE table_name='cdm_reads' ORDER BY ordinal_position`);
await q("items created per minute (last 12 min)", `
  SELECT date_trunc('minute', created_at) AS minute, count(*) AS items_created
  FROM items WHERE created_at > now() - interval '12 minutes'
  GROUP BY 1 ORDER BY 1 DESC`);
await q("items last_seen per minute (last 12 min)", `
  SELECT date_trunc('minute', last_seen_at) AS minute, count(*) AS items_seen
  FROM items WHERE last_seen_at > now() - interval '12 minutes'
  GROUP BY 1 ORDER BY 1 DESC`);
await q("5 most recently created items", `
  SELECT epc, status, location_id, created_at, last_seen_at
  FROM items ORDER BY created_at DESC LIMIT 5`);
await q("total in-stock items right now", `SELECT count(*) AS total_in_stock FROM items WHERE status='in-stock'`);
await c.end();
