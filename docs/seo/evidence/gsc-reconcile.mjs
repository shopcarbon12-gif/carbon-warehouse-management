import crypto from "node:crypto"; import fs from "node:fs";
const k=JSON.parse(fs.readFileSync("shopify-ai-catalog-a415c0dc835e.json","utf8"));
const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url"); const now=Math.floor(Date.now()/1000);
const h=b({alg:"RS256",typ:"JWT"}), p=b({iss:k.client_email,scope:"https://www.googleapis.com/auth/webmasters.readonly",aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600});
const sig=crypto.sign("RSA-SHA256",Buffer.from(h+"."+p),k.private_key).toString("base64url");
const t=await (await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:h+"."+p+"."+sig})})).json();
const site=encodeURIComponent("sc-domain:shopcarbon.com");
async function q(body){const r=await fetch(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`,{method:"POST",headers:{authorization:"Bearer "+t.access_token,"content-type":"application/json"},body:JSON.stringify({type:"web",dataState:"final",...body})});return r.json();}
const W={startDate:"2026-07-12",endDate:"2026-10-09"};
const sum=rows=>({clicks:rows.reduce((a,r)=>a+r.clicks,0),impr:rows.reduce((a,r)=>a+r.impressions,0),rows:rows.length});
const all=async(body)=>{let rows=[],start=0;for(;;){const d=await q({...body,rowLimit:25000,startRow:start});const r=d.rows||[];rows.push(...r);if(r.length<25000)break;start+=25000}return rows};
const total=await q({...W});                         // property total, no dimensions
const byDate=await all({...W,dimensions:["date"]});
const byPage=await all({...W,dimensions:["page"]});
const byQuery=await all({...W,dimensions:["query"]});
const byQP=await all({...W,dimensions:["query","page"]});
const br=/carbon|shopcarbon|karbon/i;
const B=byQuery.filter(r=>br.test(r.keys[0]));
const out={window:W,searchType:"web",dataState:"final",
 propertyTotal:total.rows?.[0]&&{clicks:total.rows[0].clicks,impr:total.rows[0].impressions},
 byDate:sum(byDate),byPage:sum(byPage),byQuery:sum(byQuery),byQueryPage:sum(byQP),
 brandedInQueryRows:sum(B),
 homePageRows:byPage.filter(r=>/^https:\/\/shopcarbon\.com\/(\?.*)?$/.test(r.keys[0])).map(r=>({page:r.keys[0],clicks:r.clicks,impr:r.impressions})),
 // recent 56-day product-page impressions (query x page rows, nonbranded) for pilot eligibility
};
const W56={startDate:"2026-08-15",endDate:"2026-10-09"};
const qp56=await all({...W56,dimensions:["query","page"]});
const pp56=await all({...W56,dimensions:["page"]});
const prodNB={},prodAll={};
for(const r of qp56){const u=r.keys[1].split("?")[0];if(!/\/products\//.test(u))continue;if(br.test(r.keys[0]))continue;prodNB[u]=(prodNB[u]||0)+r.impressions}
for(const r of pp56){const u=r.keys[0].split("?")[0];if(!/\/products\//.test(u))continue;prodAll[u]=(prodAll[u]||0)+r.impressions}
const dist=o=>{const v=Object.values(o).sort((a,b)=>b-a);return {pages:v.length,ge50:v.filter(x=>x>=50).length,ge100:v.filter(x=>x>=100).length,ge200:v.filter(x=>x>=200).length,median:v[v.length>>1]||0}};
out.pilot56={window:W56,productPageImpr_pageDim:dist(prodAll),productPageNonbrandedImpr_queryPageRows:dist(prodNB)};
fs.writeFileSync(process.argv[2],JSON.stringify(out,null,1));console.log(JSON.stringify(out,null,1));
