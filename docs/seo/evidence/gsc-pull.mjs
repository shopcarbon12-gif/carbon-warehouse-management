import crypto from "node:crypto"; import fs from "node:fs";
const k=JSON.parse(fs.readFileSync("shopify-ai-catalog-a415c0dc835e.json","utf8"));
const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url"); const now=Math.floor(Date.now()/1000);
const h=b({alg:"RS256",typ:"JWT"}), p=b({iss:k.client_email,scope:"https://www.googleapis.com/auth/webmasters.readonly",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600});
const sig=crypto.sign("RSA-SHA256",Buffer.from(h+"."+p),k.private_key).toString("base64url");
const t=await (await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:h+"."+p+"."+sig})})).json();
const site=encodeURIComponent("sc-domain:shopcarbon.com");
async function q(body){const r=await fetch(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`,{method:"POST",headers:{authorization:"Bearer "+t.access_token,"content-type":"application/json"},body:JSON.stringify(body)});return r.json();}
const end="2026-10-09", start="2025-06-09";
const out={};
out.byQueryPage=await q({startDate:start,endDate:end,dimensions:["query","page"],rowLimit:25000});
out.byPage=await q({startDate:"2026-07-12",endDate:end,dimensions:["page"],rowLimit:25000});
out.byQuery90=await q({startDate:"2026-07-12",endDate:end,dimensions:["query"],rowLimit:25000});
fs.writeFileSync(process.argv[2],JSON.stringify(out));
console.log(Object.fromEntries(Object.entries(out).map(([k,v])=>[k,v.rows?.length??v])));
