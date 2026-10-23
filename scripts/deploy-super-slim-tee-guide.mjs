/**
 * Deploy the Men's Super Slim Fit T-Shirts size guide (owner 2026-10-23: "use
 * the same sizing guide … call it super slim fit t-shirts, add it only to
 * damian"): the new snippet, its router entry, the product page's list of
 * guide types, and custom.size_guide_type on the Damian Shirt only. The live
 * copies of the edited files and Damian's previous guide type are saved first.
 *
 *   node scripts/deploy-super-slim-tee-guide.mjs            # dry run
 *   node scripts/deploy-super-slim-tee-guide.mjs --write
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");
function env(key) {
  for (const f of [".env.coolify.local", ".env.local"]) {
    const p = path.join(ROOT, f);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    if (m) return m[1].trim();
  }
  return "";
}
const SHOP = env("SHOPIFY_SHOP_DOMAIN");
const TOKEN = env("SHOPIFY_ADMIN_ACCESS_TOKEN");
async function gql(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/2026-07/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}
const FILES = ["snippets/carbon-size-guide-mens-tshirt-super-slim.liquid", "snippets/carbon-size-guide-router.liquid", "snippets/product-information.liquid"];
const theme = (await gql(`{ themes(first: 5, roles: [MAIN]) { nodes { id name role } } }`)).themes.nodes[0];
console.log(`theme: ${theme.name} (${theme.role})`);
const read = async (f) => (await gql(
  `query($id:ID!,$f:[String!]){ theme(id:$id){ files(filenames:$f, first:10){ nodes{ filename body{ ... on OnlineStoreThemeFileBodyText{content} } } } } }`,
  { id: theme.id, f },
)).theme.files.nodes;
const live = new Map((await read(FILES)).map((n) => [n.filename, n.body.content]));
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
for (const f of FILES) {
  const local = readFileSync(path.join(ROOT, "theme", f), "utf8");
  console.log(`  ${f}: ${live.has(f) ? (live.get(f) === local ? "same as live" : "differs from live") : "new"}`);
  if (WRITE && live.has(f) && live.get(f) !== local) writeFileSync(path.join(ROOT, `theme/backups/${path.basename(f, ".liquid")}.PRE-SUPER-SLIM-TEE-${stamp}.liquid`), live.get(f));
}
// The Damian Shirt: its current guide type (kept in the backups folder), then the new one.
const DAMIAN = "gid://shopify/Product/9217476428028";
const cur = (await gql(`query($id:ID!){ product(id:$id){ title handle metafield(namespace:"custom", key:"size_guide_type"){ value type } } }`, { id: DAMIAN })).product;
console.log(`product: ${cur.title} (${cur.handle}) — size_guide_type now: ${cur.metafield ? `${cur.metafield.value} (${cur.metafield.type})` : "none"}`);
if (WRITE) writeFileSync(path.join(ROOT, `theme/backups/damian-size-guide-type.PRE-SUPER-SLIM-TEE-${stamp}.json`), JSON.stringify(cur, null, 1));
if (!WRITE) { console.log("dry run — re-run with --write"); process.exit(0); }
const up = await gql(
  `mutation($id:ID!,$files:[OnlineStoreThemeFilesUpsertFileInput!]!){ themeFilesUpsert(themeId:$id, files:$files){ upsertedThemeFiles{ filename } userErrors{ filename message } } }`,
  { id: theme.id, files: FILES.map((f) => ({ filename: f, body: { type: "TEXT", value: readFileSync(path.join(ROOT, "theme", f), "utf8") } })) },
);
if (up.themeFilesUpsert.userErrors.length) throw new Error(JSON.stringify(up.themeFilesUpsert.userErrors));
const back = new Map((await read(FILES)).map((n) => [n.filename, n.body.content]));
for (const f of FILES) console.log(`read back ${f}: ${back.get(f) === readFileSync(path.join(ROOT, "theme", f), "utf8") ? "matches" : "DIFFERS"}`);
// The field is a list of choices: add this guide's value to it (the existing ones kept).
const def = (await gql(`{ metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: "custom", key: "size_guide_type") { nodes { id validations { name value } } } }`)).metafieldDefinitions.nodes[0];
const choicesV = def?.validations.find((v) => v.name === "choices");
if (choicesV) {
  const choices = JSON.parse(choicesV.value);
  if (!choices.includes("mens-tshirt-super-slim")) {
    const vs = def.validations.map((v) => (v.name === "choices" ? { name: "choices", value: JSON.stringify([...choices, "mens-tshirt-super-slim"]) } : { name: v.name, value: v.value }));
    const u = await gql(
      `mutation($d: MetafieldDefinitionUpdateInput!){ metafieldDefinitionUpdate(definition: $d){ updatedDefinition{ validations{ name value } } userErrors{ field message } } }`,
      { d: { ownerType: "PRODUCT", namespace: "custom", key: "size_guide_type", validations: vs } },
    );
    if (u.metafieldDefinitionUpdate.userErrors.length) throw new Error(JSON.stringify(u.metafieldDefinitionUpdate.userErrors));
    console.log("choices now:", u.metafieldDefinitionUpdate.updatedDefinition.validations.find((v) => v.name === "choices")?.value);
  }
}
const mf = await gql(
  `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ metafields{ key value } userErrors{ field message } } }`,
  { m: [{ ownerId: DAMIAN, namespace: "custom", key: "size_guide_type", type: cur.metafield?.type ?? "single_line_text_field", value: "mens-tshirt-super-slim" }] },
);
if (mf.metafieldsSet.userErrors.length) throw new Error(JSON.stringify(mf.metafieldsSet.userErrors));
const after = (await gql(`query($id:ID!){ product(id:$id){ metafield(namespace:"custom", key:"size_guide_type"){ value } } }`, { id: DAMIAN })).product;
console.log(`Damian size_guide_type: ${after.metafield?.value}`);
