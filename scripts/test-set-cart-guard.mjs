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

/* Products whose page config is treated as carbon_set.by_colour = true, before
   that metafield is live (the test runs the local snippet, not the live one). */
let BY_COLOUR = new Set();
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
    if (u.startsWith("/products/")) {
      const r = await live(u);
      let text = r.text;
      const h = u.slice("/products/".length);
      if (BY_COLOUR.has(h) && !text.includes('"byColour": true')) text = text.replace('"partners":', '"byColour": true, "partners":');
      return { ok:r.ok, text: async () => text, json: async () => JSON.parse(r.text || "{}") };
    }
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
/* A line in one colour, for by-colour sets: the key names the colour so two
   colours of one product are two lines. */
const C = (h, colour, q = 1) => ({ key: `${h}:${colour}`, handle: h, quantity: q, properties: {},
  options_with_values: [{ name: "Color", value: colour }, { name: "Size", value: "38" }] });

console.log("\nREAL partner data from shopcarbon.com\n");
const res = [];
res.push(await run("Alia complete pair survives (the stale link is repaired)",
  [L("alia-shorts-set"), L("alia-crop-set")], []));
res.push(await run("Alia, one piece removed → the other goes",
  [L("alia-crop-set")], ["alia-crop-set"]));
res.push(await run("Lily complete three-piece survives",
  [L("lily-top-set"), L("lily-jacket-set"), L("lily-pants-set")], []));
res.push(await run("Lily minus the pants → top and jacket go",
  [L("lily-top-set"), L("lily-jacket-set")], ["lily-jacket-set","lily-top-set"]));
res.push(await run("non-set product on its own is untouched",
  [L("maci-legging")], []));
res.push(await run("complete set + unrelated product → nothing removed",
  [L("lily-top-set"), L("lily-jacket-set"), L("lily-pants-set"), L("maci-legging")], []));
res.push(await run("solo-tagged piece is left alone",
  [L("alia-crop-set", 1, { _carbon_set_solo:"1" })], []));

console.log("\nVera (by colour: blue blazer ↔ blue shorts, green blazer ↔ green shorts)\n");
BY_COLOUR = new Set(["vera-blazer-set", "vera-shorts", "vera-shorts-set"]);
res.push(await run("blue blazer + blue shorts survives (the green shorts are not part of it)",
  [C("vera-blazer-set", "BLUE"), C("vera-shorts", "BLUE")], []));
res.push(await run("green blazer + green shorts survives",
  [C("vera-blazer-set", "GREEN"), C("vera-shorts-set", "GREEN")], []));
res.push(await run("both colours, both complete → nothing removed",
  [C("vera-blazer-set", "BLUE"), C("vera-shorts", "BLUE"), C("vera-blazer-set", "GREEN"), C("vera-shorts-set", "GREEN")], []));
res.push(await run("blue blazer alone → it goes",
  [C("vera-blazer-set", "BLUE")], ["vera-blazer-set:BLUE"]));
res.push(await run("blue blazer + GREEN shorts is not a set → both go",
  [C("vera-blazer-set", "BLUE"), C("vera-shorts-set", "GREEN")], ["vera-blazer-set:BLUE", "vera-shorts-set:GREEN"]));
res.push(await run("blue + green complete, green shorts removed → only the green blazer goes",
  [C("vera-blazer-set", "BLUE"), C("vera-shorts", "BLUE"), C("vera-blazer-set", "GREEN")], ["vera-blazer-set:GREEN"]));
BY_COLOUR = new Set();
console.log(`\n${res.filter(Boolean).length}/${res.length} passed`);
process.exit(res.every(Boolean) ? 0 : 1);
