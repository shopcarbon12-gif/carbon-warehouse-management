/* eslint-disable no-console */
/**
 * Runs the live set-cart guard snippet against real partner data.
 *
 * The guard is theme JavaScript, so the only honest way to check it is to
 * execute the snippet itself with the cart stubbed and /products/* answered
 * from the real storefront — the partner handles come from live metafields,
 * which is where the one bug that mattered actually lived.
 *
 *   node scripts/test-set-cart-guard.mjs
 */
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../theme/snippets/carbon-set-cart-guard.liquid", import.meta.url),"utf8")
  .match(/<script>([\s\S]*?)<\/script>/)[1];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const realFetch = global.fetch;
const cache = new Map();
async function live(path) {
  if (cache.has(path)) return cache.get(path);
  for (let i = 0; i < 5; i++) {
    const r = await realFetch("https://shopcarbon.com" + path, { headers: { "User-Agent": UA } });
    if (r.ok) { const v = { ok: true, text: await r.text() }; cache.set(path, v); return v; }
    if (r.status === 404) { const v = { ok: false, text: "" }; cache.set(path, v); return v; }
    await new Promise(z => setTimeout(z, 1500));
  }
  return { ok: false, text: "" };
}

async function run(name, lines, expect) {
  let updates = null;
  const noop = { setAttribute(){}, style:{cssText:""}, textContent:"", insertBefore(){}, querySelectorAll:()=>[], firstChild:null };
  global.document = { readyState:"complete", addEventListener(){}, querySelector:()=>noop,
    querySelectorAll:()=>[], createElement:()=>({setAttribute(){},style:{cssText:""},textContent:""}), body:noop };
  global.window = { location:{ pathname:"/cart", reload(){} }, addEventListener(){}, fetch:undefined, XMLHttpRequest:undefined };
  global.setInterval = () => 0;
  global.fetch = async (url, opt) => {
    const u = String(url);
    if (u === "/cart.js") return { ok:true, json: async () => ({ items: lines, item_count: lines.length }) };
    if (u === "/cart/update.js") { updates = JSON.parse(opt.body).updates; return { ok:true, json: async () => ({}) }; }
    if (u.startsWith("/products/")) { const r = await live(u); return { ok:r.ok, text: async () => r.text, json: async () => JSON.parse(r.text || "{}") }; }
    return { ok:false };
  };
  global.window.fetch = global.fetch;
  new Function(src)();
  await new Promise(r => setTimeout(r, 7000));
  const zeroed = Object.entries(updates || {}).filter(([,v]) => v === 0).map(([k]) => k).sort();
  const ok = JSON.stringify(zeroed) === JSON.stringify(expect.slice().sort());
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`        removed [${zeroed.join(", ")}]  expected [${expect.join(", ")}]`);
  return ok;
}
const L = (h, q = 1, props = {}) => ({ key: h, handle: h, quantity: q, properties: props });

console.log("\nREAL partner data from shopcarbon.com\n");
const res = [];
res.push(await run("Alia complete pair survives (the stale link is repaired)",
  [L("alia-shorts-set"), L("alia-crop-tank")], []));
res.push(await run("Alia, one piece removed → the other goes",
  [L("alia-crop-tank")], ["alia-crop-tank"]));
res.push(await run("Lily complete three-piece survives",
  [L("lily-top-set"), L("lily-jacket-set"), L("lily-pants-set")], []));
res.push(await run("Lily minus the pants → top and jacket go",
  [L("lily-top-set"), L("lily-jacket-set")], ["lily-jacket-set","lily-top-set"]));
res.push(await run("non-set product on its own is untouched",
  [L("maci-legging")], []));
res.push(await run("complete set + unrelated product → nothing removed",
  [L("lily-top-set"), L("lily-jacket-set"), L("lily-pants-set"), L("maci-legging")], []));
res.push(await run("solo-tagged piece is left alone",
  [L("alia-crop-tank", 1, { _carbon_set_solo:"1" })], []));
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
