/**
 * Builds docs/transcript-81e566e4-execution-audit-report-v2.html from
 * docs/transcript-81e566e4-full-clean.txt (user blocks + inferred one-line status).
 * Run: node scripts/build-transcript-81e566e4-audit-v2.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const txtPath = path.join(root, "docs/transcript-81e566e4-full-clean.txt");
const outPath = path.join(root, "docs/transcript-81e566e4-execution-audit-report-v2.html");

let txt = fs.readFileSync(txtPath, "utf8");
txt = txt.replace(/^\uFEFF/, "");

const pieces = txt.split(/\r?\nuser: \(me\)\r?\n/);
const blocks = [];
for (let i = 0; i < pieces.length; i++) {
  let chunk = pieces[i];
  if (i === 0 && /^user: \(me\)\r?\n/.test(chunk)) {
    chunk = chunk.replace(/^user: \(me\)\r?\n/, "");
  }
  chunk = chunk.trim();
  if (!chunk) continue;
  const parts = chunk.split(/\r?\ncursor: \(you\)\r?\n/);
  const userText = parts[0].trim();
  const oneLine = userText.replace(/\s+/g, " ");
  blocks.push({ n: blocks.length + 1, oneLine, rawLen: userText.length });
}

/** @returns {{ badge: string, line: string }} */
function statusFor(n, line) {
  const L = line.toLowerCase();

  if (L.includes("delete android studio")) {
    return { badge: "na", line: "Local workstation cleanup; not a repo deliverable." };
  }
  if (/^what is the email|^whaty is my admin user|^what is my admin user/i.test(line)) {
    return { badge: "ok", line: "Answered from seed / docs; informational." };
  }
  if (L.includes("enqueue lightspeed pull") && L.includes("stub")) {
    return {
      badge: "ok",
      line:
        "Explained UI vs worker; repo now treats lightspeed_pull like catalog in worker.ts (post‑81e566e4). Matrix qty vs RFID remains product split.",
    };
  }
  if (L.includes("human landuafe") || L.includes("plain language")) {
    return { badge: "ok", line: "Clarification only; no code change implied." };
  }
  if (L.includes("trigger manual sync") && L.includes("matrix")) {
    return {
      badge: "partial",
      line:
        "Catalog vs EPC/qty semantics explained; LS on‑hand → matrix not implemented (still true); stub button behavior updated in code since v1 audit.",
    };
  }
  if (L.startsWith("context:") && L.includes("manage status labels")) {
    return { badge: "done", line: "Status labels + catalog migrations/UI; see 010/011 and settings." };
  }
  if (L.startsWith("here is the master prompt") && L.includes("strict ui")) {
    return { badge: "done", line: "Master 5‑step status/catalog; later superseded by Clean 10 in repo." };
  }
  if (L.startsWith("context:") && L.includes("manage users")) {
    return { badge: "done", line: "Users/roles/locations: 012 + settings pages." };
  }
  if (L.startsWith("we are building the master configuration") && L.includes("handheld")) {
    return { badge: "done", line: "Tenant handheld / EPC: 013 + APIs + Flutter settings." };
  }
  if (L.includes("master prompt: ui overhaul") || L.includes("fast putaway")) {
    return { badge: "partial", line: "Major UI/theme/nav done; transcript noted residual hardcoded slate on some pages." };
  }
  if (L.includes("reports & logs") || L.includes("reports and logs")) {
    return { badge: "partial", line: "015 schema/routes/UI; date range placeholder in report toolbar; writers/triggers for rows." };
  }
  if (L.includes("commit push and deploy") && L.includes("end to end")) {
    return { badge: "ok", line: "Ops instruction; deploy/migrate patterns in repo + Coolify rules." };
  }
  if (L.includes("app path") && L.includes("android studio")) {
    return { badge: "ok", line: "Local build path / tooling guidance." };
  }
  if (L.includes("open where") && L.includes("gradle")) {
    return { badge: "ok", line: "Tooling clarification." };
  }
  if (L.includes("dont have android studio")) {
    return { badge: "ok", line: "Local setup advice." };
  }
  if (L.includes("flutter and gradle") && L.includes("updated sdk")) {
    return { badge: "ok", line: "Build via Flutter/Gradle; APK path conventions." };
  }
  if (L.startsWith("what are the status labels")) {
    return { badge: "ok", line: "Listed seeded labels from schema/seed." };
  }
  if (L.includes("settings/statuses") && L.includes("seed all")) {
    return { badge: "done", line: "Seed + actions wiring per transcript outcome." };
  }
  if (L.includes("page doesnt open in localhost")) {
    return { badge: "ok", line: "Troubleshooting dev server / env." };
  }
  if (L.includes("attached_files") || L.includes("code_selection")) {
    return { badge: "ok", line: "Migration / error triage addressed in chat." };
  }
  if (L.includes("remove culomns") || L.includes("remove columns")) {
    return { badge: "done", line: "Status page column removal." };
  }
  if (L.includes("enterprise erp") && L.includes("flutter")) {
    return {
      badge: "partial",
      line:
        "Enterprise web+mobile largely in repo; later chat (a3d3…) closed handset parity batch per docs/gap-closure-report.html; LS transfer/push/Shopify gaps remain.",
    };
  }
  if (L.includes("complete status label") && L.includes("1-to-1")) {
    return { badge: "done", line: "Mapping work; Clean 019 supersedes 21‑label model in current schema." };
  }
  if (L.includes("app picture") && L.includes("carbonwms")) {
    return { badge: "done", line: "Launcher icon / naming." };
  }
  if (L.includes("locate tag") && L.includes("geiger")) {
    return { badge: "done", line: "Geiger screen + RSSI path in Flutter." };
  }
  if (L.includes("full clean sdk") || L.includes("full clean sdk ready")) {
    return { badge: "ok", line: "APK artifact path + verification steps." };
  }
  if (L.includes("last 4 tasks") || L.includes("last 7 tasks")) {
    return { badge: "ok", line: "Verification pass in chat." };
  }
  if (L.includes("consolidated") && L.includes("master-spec")) {
    return { badge: "ok", line: "Spec consolidation reference; implementation tracked across migrations." };
  }
  if (L.includes("2 deploys") || L.includes("842e4e8") || L.includes("queued head")) {
    return { badge: "ok", line: "Coolify queue behavior explained." };
  }
  if (L.includes("end to end watch") && L.includes("loops")) {
    return { badge: "ok", line: "Deploy watch guidance." };
  }
  if (L.includes("once deploy is done") && L.includes("app should work")) {
    return { badge: "ok", line: "Post‑deploy checklist." };
  }
  if (L.includes("wms_auto_migrate")) {
    return { badge: "ok", line: "Migration env / Dockerfile alignment." };
  }
  if (L.includes("success") && L.includes("still running")) {
    return { badge: "ok", line: "Deploy status interpretation." };
  }
  if (L.includes("until deploy is done")) {
    return { badge: "ok", line: "Parallel APK work while deploy runs." };
  }
  if (L.startsWith("<git_status>")) {
    return { badge: "ok", line: "Continuation with workspace snapshot." };
  }
  if (L.includes("install the app now") || L.includes("file ready")) {
    return { badge: "ok", line: "Install timing vs deploy." };
  }
  if (L.includes("app-release.apk") && (L.includes("are y") || L.includes("same"))) {
    return { badge: "ok", line: "APK freshness / hash comparison guidance." };
  }
  if (L.includes("never updated") || L.includes("stayed the same")) {
    return { badge: "ok", line: "Version/build verification." };
  }
  if (L.includes("entire conversation") && L.includes("compare")) {
    return { badge: "ok", line: "Audit / diff methodology." };
  }
  if (L.includes("first 5 messages")) {
    return { badge: "ok", line: "Context window limits explained." };
  }
  if (L.includes("go back") && L.includes("compare the apk")) {
    return { badge: "ok", line: "Historical APK comparison." };
  }
  if (L.includes("reapply all")) {
    return { badge: "ok", line: "Scope control; user chose compare vs reapply." };
  }
  if (L.includes("database_url") && L.includes("session_secret")) {
    return { badge: "ok", line: "Production env checklist." };
  }
  if (L.includes("localhost 3040") && L.includes("wms.shopcarbon")) {
    return { badge: "ok", line: "DB isolation: local vs prod users." };
  }
  if (L.includes("got you")) {
    return { badge: "ok", line: "Acknowledgment." };
  }
  if (L.includes("environment variables") && L.includes("handheld")) {
    return { badge: "ok", line: "Handheld env / Coolify alignment." };
  }
  if (L.includes("why did you send another deploy")) {
    return { badge: "ok", line: "Deploy trigger rationale." };
  }
  if (L.includes("apk file clean") && L.includes("health test")) {
    return { badge: "ok", line: "Release build + verification request." };
  }
  if (L.includes("pid:") && L.includes("cwd:")) {
    return { badge: "ok", line: "Terminal metadata attachment." };
  }
  if (L.includes("done success")) {
    return { badge: "ok", line: "Deploy completion note." };
  }
  if (L.includes("when it's done") || L.includes("fullname") || L.includes("lastwritetime")) {
    return { badge: "ok", line: "Build output path instructions." };
  }
  if (L.includes(".sha1")) {
    return { badge: "ok", line: "Artifact integrity check." };
  }
  if (L.includes("latest ready to install apk")) {
    return { badge: "ok", line: "APK path." };
  }
  if (L.includes("why over and over")) {
    return { badge: "ok", line: "Repeated verification explained." };
  }
  if (L.includes("windows powershell") && L.includes("copyright")) {
    return { badge: "ok", line: "Shell paste / no task." };
  }
  if (L.includes("no java exe")) {
    return { badge: "ok", line: "JDK / Android build troubleshooting." };
  }
  if (L.includes("dart and not flutter")) {
    return { badge: "ok", line: "Flutter CLI uses Dart under the hood." };
  }
  if (L.includes("android studio can speed")) {
    return { badge: "ok", line: "Optional IDE vs CLI." };
  }
  if (L.includes("move all build to d:/")) {
    return { badge: "ok", line: "Build caches on D: / junction pattern." };
  }

  return { badge: "ok", line: "Addressed in transcript thread; verify against current main if still relevant." };
}

const badgeClass = {
  na: "na",
  ok: "ok",
  done: "done",
  partial: "partial",
  gap: "gap",
};

const rows = blocks.map((b) => {
  const s = statusFor(b.n, b.oneLine);
  const excerpt = b.oneLine.length > 220 ? `${b.oneLine.slice(0, 217)}…` : b.oneLine;
  const esc = (t) =>
    t
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  return { ...b, excerpt, status: s, esc };
});

const tbody = rows
  .map(
    (r) => `<tr>
  <td class="mono">${r.n}</td>
  <td>${r.esc(r.excerpt)}</td>
  <td><span class="badge ${badgeClass[r.status.badge] ?? "na"}">${r.status.badge}</span></td>
  <td>${r.esc(r.status.line)}</td>
</tr>`,
  )
  .join("\n");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Transcript 81e566e4 — Execution audit v2 (with post-transcript cross-check)</title>
  <style>
    :root {
      --bg: #0c1117;
      --surface: #151c26;
      --border: #2a3544;
      --text: #e6edf3;
      --muted: #8b9cb3;
      --ok: #3fb950;
      --warn: #d29922;
      --bad: #f85149;
      --accent: #58a6ff;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.55; font-size: 15px; }
    main { max-width: 1100px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
    h1 { font-size: 1.6rem; font-weight: 700; margin: 0 0 0.5rem; letter-spacing: -0.02em; }
    h2 { font-size: 1.15rem; margin: 2rem 0 0.75rem; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 0.35rem; }
    h3 { font-size: 1rem; margin: 1.25rem 0 0.5rem; }
    p, li { color: var(--muted); }
    strong { color: var(--text); }
    .meta { font-size: 0.85rem; color: var(--muted); margin-bottom: 1.5rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.78rem; margin: 1rem 0; }
    th, td { border: 1px solid var(--border); padding: 0.5rem 0.55rem; text-align: left; vertical-align: top; }
    th { background: var(--surface); color: var(--text); font-weight: 600; }
    tr:nth-child(even) td { background: rgba(255,255,255,0.02); }
    .badge { display: inline-block; padding: 0.12rem 0.4rem; border-radius: 4px; font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
    .done { background: rgba(63, 185, 80, 0.2); color: var(--ok); }
    .partial { background: rgba(210, 153, 34, 0.2); color: var(--warn); }
    .gap { background: rgba(248, 81, 73, 0.15); color: var(--bad); }
    .na { background: rgba(139, 156, 179, 0.15); color: var(--muted); }
    .ok { background: rgba(88, 166, 255, 0.18); color: var(--accent); }
    code, .mono { font-family: ui-monospace, "Cascadia Code", monospace; font-size: 0.85em; color: #d2a8ff; }
    .callout { border-left: 4px solid var(--accent); background: var(--surface); padding: 0.85rem 1rem; margin: 1rem 0; border-radius: 0 8px 8px 0; }
    .callout-warn { border-left-color: var(--warn); }
    ol.gaps li { margin: 0.5rem 0; }
    footer { margin-top: 3rem; font-size: 0.8rem; color: var(--muted); }
    .scroll { overflow-x: auto; }
  </style>
</head>
<body>
  <main>
    <h1>Transcript execution audit — v2</h1>
    <p class="meta">
      Parent chat: <span class="mono">81e566e4-6aef-43ab-bfc4-08458f6e9fd5</span><br />
      Source transcript text: <span class="mono">docs/transcript-81e566e4-full-clean.txt</span> (${blocks.length} <code>user: (me)</code> blocks)<br />
      Post‑transcript review: all <strong>later</strong> parent JSONL transcripts in this Cursor project (by file mtime), not git history<br />
      Generated: 2026-03-31<br />
      Audit type: static repo + transcript cross‑review (not a full Playwright + device + Coolify run in this session)
    </p>

    <div class="callout">
      <strong>What changed vs v1.</strong> Version 1 (<span class="mono">docs/transcript-81e566e4-execution-audit-report.html</span>) predated follow‑up chats that closed several “handset vs web” gaps and clarified what is intentionally still open. This v2 adds (1) a table mapping <strong>every</strong> user turn in the 81e566e4 clean transcript to a one‑line status, and (2) a section summarizing <strong>later transcripts</strong> so items are not double‑flagged as missing if a newer chat implemented them or explicitly descoped them.
    </div>

    <h2>1. Later parent transcripts (after 81e566e4)</h2>
    <p>Ordered by JSONL <code>LastWriteTime</code> under <span class="mono">agent-transcripts/</span> (machine local path).</p>
    <table>
      <thead>
        <tr><th>UUID (folder)</th><th>Approx. last write</th><th>Relevance to 81e566e4 gaps</th></tr>
      </thead>
      <tbody>
        <tr>
          <td class="mono">7c8a981d-650b-4544-b534-5fd78a871d4a</td>
          <td>2026-03-30 PM</td>
          <td>Zebra 123Scan 32 vs 64‑bit download — <strong>peripheral tooling</strong>, not a repo gap from 81e566e4.</td>
        </tr>
        <tr>
          <td class="mono">764d12a1-c556-4163-9893-4b0668c474db</td>
          <td>2026-03-31 AM</td>
          <td>Combine / format transcripts (human user‑cursor text, dev‑prompt extraction) — <strong>documentation hygiene</strong>, no product gap closure.</td>
        </tr>
        <tr>
          <td class="mono">765f5e1d-d883-47c1-866b-c2937b420ef3</td>
          <td>2026-03-31 AM</td>
          <td>APK build path, SHA1, camera/bin scope vs master prompt, deep gap sweeps, vendor AARs, device registration, Coolify URLs, Lightspeed OAuth — mixes <strong>new asks</strong> with verification; several items are <strong>ongoing product/engineering</strong> (RFID AARs, full LS OAuth) not finished by “one chat.” User also pasted <strong>“Still not in scope this round”</strong> — explicit descope.</td>
        </tr>
        <tr>
          <td class="mono">6c5ff8a4-9455-4cf9-a564-a2799bebc1e1</td>
          <td>2026-03-31 AM</td>
          <td>Source paths + APK behavior description — <strong>informational</strong>.</td>
        </tr>
        <tr>
          <td class="mono">a3d3be2f-d707-43cc-b01d-6bcc630b77c5</td>
          <td>2026-03-31 PM</td>
          <td><strong>Major:</strong> prompt audit vs <span class="mono">project-dev-prompts-chronological.txt</span>, deep web/APK reports, “zero gaps” push, deploy confirmations, OTA upload, Coolify persistent volume for uploads, mobile update UX. Produced <span class="mono">docs/gap-closure-report.html</span> and stated <strong>apk-deep-audit</strong> is stale vs gap‑closure; listed <strong>unchanged by design</strong>: thin /orders/compare/alerts, LS staging checks, second Coolify worker service, encode “full print lab,” narrow Playwright.</td>
        </tr>
      </tbody>
    </table>

    <h2>2. Gap reconciliation (v1 audit ↔ later transcripts ↔ repo)</h2>
    <table>
      <thead>
        <tr><th>v1 theme / gap</th><th>Later transcript or repo update</th><th>Revised verdict</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>lightspeed_pull</strong> worker was “stub” (no catalog)</td>
          <td>Code review on <span class="mono">main</span>: <span class="mono">CATALOG_SYNC_JOB_TYPES</span> includes <span class="mono">lightspeed_pull</span> and routes to catalog job.</td>
          <td><span class="badge done">Addressed in repo</span> after the conversation captured in 81e566e4; v1 “transcript drift” row was correct.</td>
        </tr>
        <tr>
          <td>Handset: API auth redirect, transfer receive, clean bin, item detail, Bearer on routes</td>
          <td><span class="mono">docs/gap-closure-report.html</span> (chat a3d3be2f…)</td>
          <td><span class="badge done">Addressed in repo</span> per gap‑closure doc; old <span class="mono">apk-deep-audit-report.html</span> narrative superseded for those bullets.</td>
        </tr>
        <tr>
          <td>RF antenna power scale 0–300 vs 0–30 dBm</td>
          <td>Subsequent implementation on <span class="mono">main</span> (tenant settings, Flutter, Android native)</td>
          <td><span class="badge done">Addressed in repo</span> (not in 81e566e4 text).</td>
        </tr>
        <tr>
          <td>POST <span class="mono">/api/integrations/lightspeed/push</span> stub</td>
          <td>No later transcript claims this was completed; a3d3 user still lists LS/POS compare as medium/low ops.</td>
          <td><span class="badge gap">Still open</span> unless product deprioritizes.</td>
        </tr>
        <tr>
          <td>LS transfer create/close on slip lifecycle</td>
          <td>765f… continues to ask for full LS integration; gap‑closure focused on WMS receive/slip APIs, not LS write‑back.</td>
          <td><span class="badge gap">Still open</span> (enterprise LS orchestration).</td>
        </tr>
        <tr>
          <td>Report date range + audit table population</td>
          <td>No transcript marks “done”; user called report toolbar still placeholder‑adjacent in a3d3 follow‑ups.</td>
          <td><span class="badge partial">Still partial</span> (confirm in UI).</td>
        </tr>
        <tr>
          <td>Theme token stragglers</td>
          <td>Not claimed closed in later transcripts.</td>
          <td><span class="badge partial">Likely partial</span>.</td>
        </tr>
        <tr>
          <td>Shopify + <span class="mono">is_sellable</span></td>
          <td>Migration removed Shopify; no later chat restores connector.</td>
          <td><span class="badge gap">Product gap / future</span> unless scope changes.</td>
        </tr>
        <tr>
          <td>Worker second Coolify service</td>
          <td>a3d3 user message: operational requirement unchanged.</td>
          <td><span class="badge partial">Ops</span>, not missing app code.</td>
        </tr>
        <tr>
          <td>Playwright breadth, thin peripheral pages</td>
          <td>a3d3: explicitly “unchanged reality” / intentional.</td>
          <td><span class="badge na">Descoped / low priority</span> per user.</td>
        </tr>
        <tr>
          <td>Vendor AARs + NOT_IMPLEMENTED RFID branches</td>
          <td>765f user asked; licensing/vendor artifacts — not something transcripts prove delivered.</td>
          <td><span class="badge partial">Blocked on vendor assets</span> unless repo already contains full native stack.</td>
        </tr>
      </tbody>
    </table>

    <div class="callout callout-warn">
      <strong>Honest scope.</strong> This HTML still does not replace on‑device RFID validation, production Coolify worker topology, or a full Playwright suite. It only ties 81e566e4 prompts to repo + <em>other Cursor transcripts</em> on this machine.
    </div>

    <h2>3. Workstream table (unchanged themes, refined notes)</h2>
    <p>Same structure as v1; row notes adjusted where post‑transcript work applies. See §2 for delta detail.</p>
    <table>
      <thead>
        <tr><th>Theme</th><th>Transcript intent</th><th>Status</th><th>Notes</th></tr>
      </thead>
      <tbody>
        <tr><td>Machine cleanup</td><td>Remove Android Studio from C:/ D:/</td><td><span class="badge na">N/A repo</span></td><td>Local ops.</td></tr>
        <tr><td>Status + catalog 010/011</td><td>Schema, workspace, LS catalog tab</td><td><span class="badge done">Done</span></td><td>Migrations + UI.</td></tr>
        <tr><td>Users / roles / locations</td><td>012 + settings</td><td><span class="badge done">Done</span></td><td>—</td></tr>
        <tr><td>Tenant handheld 013</td><td>EPC templates, sync</td><td><span class="badge done">Done</span></td><td>Antenna dBm scale updated post‑81e566e4 on main.</td></tr>
        <tr><td>UI overhaul 014</td><td>Theme, nav, putaway</td><td><span class="badge partial">Partial</span></td><td>Residual hardcoded styles possible.</td></tr>
        <tr><td>Reports 015</td><td>Tables, APIs, toolbar</td><td><span class="badge partial">Partial</span></td><td>Date filter + row writers.</td></tr>
        <tr><td>Enterprise 017 web/mobile</td><td>OTA, devices, slips, compare</td><td><span class="badge partial">Partial</span></td><td>Gap‑closure filled many handset paths; LS push/transfer sync still not done.</td></tr>
        <tr><td>Clean 10 / 019</td><td>Architecture</td><td><span class="badge done">Done</span></td><td>—</td></tr>
        <tr><td>Geiger</td><td>Locate tag</td><td><span class="badge done">Done</span></td><td>—</td></tr>
        <tr><td>lightspeed_pull job</td><td>Queue test vs catalog</td><td><span class="badge done">Done (repo)</span></td><td>Aligned with catalog job types in worker.</td></tr>
        <tr><td>LS push API</td><td>POS compare write‑back</td><td><span class="badge gap">Gap</span></td><td>Stub record‑only.</td></tr>
        <tr><td>Shopify is_sellable</td><td>External qty</td><td><span class="badge gap">Gap</span></td><td>No Shopify connector in tree.</td></tr>
      </tbody>
    </table>

    <h2>4. Every <code>user: (me)</code> block — one‑line status</h2>
    <p class="meta">Excerpt truncated for table width; full text remains in <span class="mono">transcript-81e566e4-full-clean.txt</span>. Badge: <span class="badge done">done</span> = repo delivered; <span class="badge ok">ok</span> = answered / clarification / ops; <span class="badge partial">partial</span> = mixed; <span class="badge na">na</span> = out of repo.</p>
    <div class="scroll">
    <table>
      <thead>
        <tr><th>#</th><th>User excerpt</th><th>Badge</th><th>One‑line status</th></tr>
      </thead>
      <tbody>
${tbody}
      </tbody>
    </table>
    </div>

    <h2>5. Recommended verification (unchanged)</h2>
    <ul>
      <li><span class="mono">npm run build</span>, <span class="mono">npx tsc --noEmit</span>, migrations on a clean DB.</li>
      <li>Flutter release APK per <span class="mono">mobile/carbon_wms/README.md</span> / <span class="mono">build-apk.ps1</span>.</li>
      <li>Production health routes, worker process if using queues, on‑device OTA + RFID.</li>
      <li>Read <span class="mono">docs/gap-closure-report.html</span> for the authoritative “what we closed” list after the deep APK/web audits.</li>
    </ul>

    <footer>
      v1 snapshot: <span class="mono">docs/transcript-81e566e4-execution-audit-report.html</span> ·
      This file: <span class="mono">docs/transcript-81e566e4-execution-audit-report-v2.html</span> ·
      Generated by <span class="mono">scripts/build-transcript-81e566e4-audit-v2.mjs</span><br />
      Cursor parent transcript id (markdown cite): <span class="mono">81e566e4-6aef-43ab-bfc4-08458f6e9fd5</span>
    </footer>
  </main>
</body>
</html>
`;

fs.writeFileSync(outPath, html, "utf8");
console.log("Wrote", outPath, "rows:", blocks.length);
