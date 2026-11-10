/**
 * The Email Marketing guide (owner, 2026-11-10: "how to create, how to change, where is the AI, where is
 * what, for all the tabs"). One text, shown two ways: the Guide panel on the Email Marketing screen
 * (components/email/guide.tsx) and the PDF (scripts/gen-email-guide-pdf.ts → public/email/guide/).
 * When a screen changes, change its part here and run the PDF script again.
 *
 * Text: **bold** is bold. Screen maps are drawn here as SVG (numbered pins + a legend), so they
 * never go stale with sample data.
 */

export type GuideBlock =
  | { t: "p"; text: string }
  | { t: "steps"; items: string[] }
  | { t: "list"; items: string[] }
  | { t: "ai" | "tip" | "warn"; text: string }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "map"; svg: string; legend: string[] };

export type GuideSection = {
  id: string;
  /** The Email Marketing tab this part explains (the panel opens here when you are on that tab). */
  tab?: string;
  title: string;
  /** Short name for the contents chips. */
  short?: string;
  intro?: string;
  parts: { title?: string; blocks: GuideBlock[] }[];
};

export const GUIDE_PDF_URL = "/email/guide/CarbonWMS-Email-Marketing-Guide.pdf";
export const GUIDE_UPDATED = "November 10, 2026";

/* ---------- screen maps ---------- */

const W = 640;
function svg(h: number, inner: string) {
  return `<svg viewBox="0 0 ${W} ${h}" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,Arial" font-size="11" style="width:100%;height:auto;display:block">${inner}</svg>`;
}
function box(x: number, y: number, w: number, h: number, label = "", o: { fill?: string; bold?: boolean; size?: number; dash?: boolean; center?: boolean } = {}) {
  const fill = o.fill ?? "rgba(128,128,128,0.10)";
  const t = label
    ? `<text x="${o.center ? x + w / 2 : x + 8}" y="${y + h / 2 + 4}" ${o.center ? 'text-anchor="middle"' : ""} fill="currentColor" font-size="${o.size ?? 11}" ${o.bold ? 'font-weight="700"' : ""}>${label}</text>`
    : "";
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="${fill}" stroke="rgba(128,128,128,0.65)" ${o.dash ? 'stroke-dasharray="4 3"' : ""}/>${t}`;
}
function pin(n: number, x: number, y: number) {
  return `<circle cx="${x}" cy="${y}" r="10" fill="#E11D48"/><text x="${x}" y="${y + 4}" text-anchor="middle" fill="#fff" font-size="11" font-weight="700">${n}</text>`;
}

const MAP_MAIN = svg(
  300,
  [
    box(0, 0, W, 300, "", { fill: "rgba(128,128,128,0.04)" }),
    `<text x="16" y="28" fill="currentColor" font-size="15" font-weight="700">Email Marketing</text>`,
    ...["EMAILS", "CAMPAIGNS", "FLOWS", "CALENDAR", "REPORTS", "AUDIENCE", "SETTINGS"].map((t, i) =>
      `<text x="${16 + i * 66}" y="62" fill="currentColor" font-size="9.5" font-family="ui-monospace,monospace" ${i === 0 ? 'font-weight="700"' : 'opacity="0.65"'}>${t}</text>`,
    ),
    `<line x1="12" y1="72" x2="${W - 12}" y2="72" stroke="rgba(128,128,128,0.6)"/>`,
    `<line x1="12" y1="72" x2="66" y2="72" stroke="currentColor" stroke-width="2"/>`,
    box(552, 46, 74, 22, "GUIDE", { center: true, size: 10 }),
    box(530, 84, 96, 24, "+ NEW EMAIL", { center: true, size: 10 }),
    ...[0, 1, 2].map((i) =>
      [
        box(16 + i * 205, 120, 195, 110, "", {}),
        box(26 + i * 205, 130, 175, 60, "email picture", { center: true, fill: "rgba(128,128,128,0.18)" }),
        `<text x="${28 + i * 205}" y="206" fill="currentColor" font-weight="700">Email name</text>`,
        `<text x="${28 + i * 205}" y="220" fill="currentColor" opacity="0.65" font-size="9.5">Subject · Edited …</text>`,
        box(16 + i * 205, 236, 195, 26, "Edit · Use in a campaign · Duplicate · 🗑", { size: 9.5 }),
      ].join(""),
    ),
    pin(1, 492, 58),
    pin(2, 600, 30),
    pin(3, 500, 96),
    pin(4, 36, 140),
    pin(5, 110, 280),
  ].join(""),
);

const MAP_EDITOR = svg(
  330,
  [
    box(0, 0, W, 330, "", { fill: "rgba(128,128,128,0.04)" }),
    box(0, 0, W, 36, "", {}),
    `<text x="32" y="23" fill="currentColor">←  Email name   ✓ Saved</text>`,
    `<text x="${W - 12}" y="23" text-anchor="end" fill="currentColor" font-size="10">🕘  Save as template   Check   Preview and test   Done</text>`,
    box(0, 36, 34, 294, "", {}),
    `<text x="17" y="66" text-anchor="middle" fill="currentColor" font-size="14">+</text>`,
    `<text x="17" y="96" text-anchor="middle" fill="currentColor" font-size="12">🎨</text>`,
    `<text x="17" y="126" text-anchor="middle" fill="currentColor" font-size="12">✉</text>`,
    box(34, 36, 170, 294, "", {}),
    `<text x="44" y="56" fill="currentColor" font-weight="700">Add content</text>`,
    `<text x="44" y="74" fill="currentColor" font-size="9.5" opacity="0.7">Basic · Pre-built · Saved</text>`,
    ...[0, 1, 2, 3, 4, 5].map((i) => box(44 + (i % 2) * 76, 86 + Math.floor(i / 2) * 44, 70, 38, ["Text", "Image", "Button", "Product", "Hero picture", "Countdown"][i], { center: true, size: 9.5 })),
    `<text x="44" y="230" fill="currentColor" font-size="9.5" opacity="0.7">Layout: Columns · Section</text>`,
    box(290, 44, 200, 22, "↶  ↷   🖥  📱", { center: true, size: 10 }),
    box(250, 74, 290, 248, "", { fill: "rgba(128,128,128,0.08)" }),
    box(270, 84, 250, 34, "CARBON logo header", { center: true }),
    box(270, 124, 250, 84, "Hero picture", { center: true, fill: "rgba(128,128,128,0.2)" }),
    `<rect x="270" y="214" width="250" height="40" rx="5" fill="none" stroke="#3B82F6" stroke-width="2"/>`,
    `<text x="395" y="238" text-anchor="middle" fill="currentColor">Text (selected)</text>`,
    box(222, 214, 22, 72, "", {}),
    `<text x="233" y="232" text-anchor="middle" fill="currentColor" font-size="9">⠿</text><text x="233" y="248" text-anchor="middle" fill="currentColor" font-size="9">↑</text><text x="233" y="262" text-anchor="middle" fill="currentColor" font-size="9">↓</text><text x="233" y="278" text-anchor="middle" fill="currentColor" font-size="9">⧉</text>`,
    box(270, 260, 250, 54, "Product grid", { center: true }),
    box(548, 124, 22, 60, "", {}),
    `<text x="559" y="144" text-anchor="middle" fill="currentColor" font-size="9">⠿</text><text x="559" y="160" text-anchor="middle" fill="currentColor" font-size="9">🔖</text><text x="559" y="176" text-anchor="middle" fill="currentColor" font-size="9">🗑</text>`,
    pin(1, 16, 18),
    pin(2, 352, 18),
    pin(3, 17, 150),
    pin(4, 120, 300),
    pin(5, 506, 55),
    pin(6, 395, 196),
    pin(7, 210, 250),
    pin(8, 590, 154),
  ].join(""),
);

const MAP_FLOW = svg(
  300,
  [
    box(0, 0, W, 300, "", { fill: "rgba(128,128,128,0.04)" }),
    box(0, 0, W, 36, "", {}),
    `<text x="32" y="23" fill="currentColor">←  Welcome series</text>`,
    box(150, 9, 44, 18, "LIVE", { center: true, size: 9, fill: "rgba(16,185,129,0.25)" }),
    `<text x="${W - 12}" y="23" text-anchor="end" fill="currentColor" font-size="10">Turn on / Pause   Back to draft   Settings   🗑</text>`,
    box(40, 50, 200, 28, "Trigger: signs up", { center: true, bold: true }),
    `<line x1="140" y1="78" x2="140" y2="250" stroke="rgba(128,128,128,0.7)"/>`,
    box(60, 92, 160, 24, "Wait 1 day", { center: true }),
    `<circle cx="140" cy="126" r="7" fill="none" stroke="currentColor"/><text x="140" y="130" text-anchor="middle" fill="currentColor" font-size="10">+</text>`,
    box(60, 138, 160, 24, "Stop if they ordered", { center: true }),
    `<rect x="40" y="174" width="200" height="40" rx="5" fill="rgba(128,128,128,0.10)" stroke="#3B82F6" stroke-width="2"/><text x="140" y="190" text-anchor="middle" fill="currentColor" font-weight="700">Email: Welcome 1</text><text x="140" y="205" text-anchor="middle" fill="currentColor" font-size="9" opacity="0.7">12 sent · 48% opened · 1 order</text>`,
    box(100, 236, 80, 22, "End", { center: true }),
    box(280, 50, 344, 210, "", {}),
    `<text x="292" y="72" fill="currentColor" font-weight="700">Email step</text>`,
    ...["Sends (off = skipped)", "Step name · Subject line · Preview text", "The email ▾   [Edit the email]", "Give each person their own Shopify code", "Test to …   [Send test]"].map(
      (t, i) => box(292, 84 + i * 34, 320, 26, t, { size: 10 }),
    ),
    box(0, 270, W, 30, "Who is in it (latest 50): Person · Entered · Where they are", { size: 10 }),
    pin(1, 210, 18),
    pin(2, 400, 18),
    pin(3, 26, 64),
    pin(4, 240, 126),
    pin(5, 26, 194),
    pin(6, 600, 72),
    pin(7, 610, 285),
  ].join(""),
);

/* ---------- the guide ---------- */

export const GUIDE: GuideSection[] = [
  {
    id: "start",
    title: "Start here",
    short: "Start here",
    intro:
      "Email Marketing is CARBON's own email platform inside CarbonWMS: you design emails with drag and drop, send them to customers as **campaigns**, and set **flows** that send by themselves (welcome, abandoned checkout, birthday…). Every email can carry a personal Shopify code, and Reports shows the sales that came from email. It is in the side menu under **Email Marketing → Emails & campaigns**.",
    parts: [
      {
        title: "The screen at a glance",
        blocks: [
          {
            t: "map",
            svg: MAP_MAIN,
            legend: [
              "**The tabs.** Each one is explained in its own part of this guide. The open tab stays in the web address, so a refresh keeps you where you are.",
              "**Guide**: opens this guide on the right, at the part for the tab you are on. **PDF** at the top of the guide downloads it.",
              "**+ New email**: start an email from one of the 70 CARBON designs, a starter, your own template, or with AI.",
              "**An email card**: a picture of the email. Click it to open the editor.",
              "**The card's buttons**: Edit, Use in a campaign, Duplicate, and the bin (delete).",
            ],
          },
        ],
      },
      {
        title: "What each tab is for",
        blocks: [
          {
            t: "table",
            head: ["Tab", "What you do there"],
            rows: [
              ["**Emails**", "Your email designs. Create, edit, duplicate, delete. This is where the drag-and-drop editor opens."],
              ["**Campaigns**", "Send one email to a list of people, once: pick the email, who gets it, the subject, an optional personal code, then approve."],
              ["**Flows**", "Automatic emails that go out by themselves when something happens (signs up, leaves a checkout, orders, birthday…)."],
              ["**Calendar**", "The holiday and season campaigns for the next 12 months. One click starts the email and a draft campaign."],
              ["**Reports**", "What email earned: emails sent, opens, clicks, orders and sales from email, per campaign and per flow."],
              ["**Audience**", "Who can be emailed, and your **segments** (groups like \"best customers\" or \"birthdays this month\")."],
              ["**Settings**", "The sender name and address, the footer address, sending speed and safety limits, and the Amazon SES connection."],
            ],
          },
        ],
      },
      {
        title: "Your first email in 10 minutes",
        blocks: [
          {
            t: "steps",
            items: [
              "**Emails → + New email.** Pick a design (open **The CARBON pack**, or a **CARBON starter** to preview it first, then **Start with this**).",
              "In the editor, click each picture spot and pick your photo. Double-click any text to change the words.",
              "Click the **envelope** icon on the far left and write the **Subject line** and **Preview text** (or press **Suggest subject lines** for AI ideas).",
              "Press **Check** (top right). Fix anything under \"Fix before sending\".",
              "Press **Preview and test → Send test** to see it in your own inbox. Then **Done**.",
              "On the email's card press **Use in a campaign**. Choose **Who gets it**, tick the personal code if you want one, **Save changes**, send yourself a **Test email**, then **Approve**.",
            ],
          },
          { t: "tip", text: "Nothing is ever sent to customers until you press **Approve** (campaigns) or **Turn on** (flows). Tests only go to the addresses you type." },
        ],
      },
      {
        title: "Where the AI is (and what it costs)",
        blocks: [
          {
            t: "table",
            head: ["AI feature", "Where to find it", "What it does"],
            rows: [
              ["**Write it with AI**", "Emails → + New email (top box)", "You describe the email; the AI picks sections, writes the words and picks in-stock products and their photos. Takes about a minute."],
              ["**Rewrite with AI**", "Editor → click a **Text** block → panel on the left", "Shorter, Bolder, Warmer, A bit longer, Fix spelling, or your own instruction. Gives 3 options to choose from."],
              ["**Ideas from AI**", "Editor → envelope icon (Subject line and preview text)", "6 subject line + preview text pairs. Click one to use it."],
              ["**Check**", "Editor → top bar → Check", "Fixed rules check links, pictures and tags; the AI reads the words for spelling, wrong brand names, made-up offers."],
              ["**Translate**", "Editor → Preview and test → Spanish and Portuguese", "Makes the Spanish and Portuguese copies of the email (about a minute)."],
            ],
          },
          {
            t: "ai",
            text: "The AI only ever writes and reads **words**. It never draws pictures and it never invents discounts. Each feature runs only when you press its button and costs a few cents a time. Campaigns, Flows, Calendar, Reports, Audience and Settings have **no AI buttons**.",
          },
        ],
      },
    ],
  },

  {
    id: "emails",
    tab: "emails",
    title: "Emails tab: your email designs",
    short: "Emails",
    intro: "Every email you build lives here as a card. Campaigns and flows use these emails.",
    parts: [
      {
        title: "The buttons on a card",
        blocks: [
          {
            t: "table",
            head: ["Button", "What it does"],
            rows: [
              ["Click the picture or **Edit**", "Opens the editor. A refresh keeps the editor open."],
              ["**Use in a campaign**", "Makes a draft campaign with this email (named after it) and opens it in Campaigns. Nothing is sent."],
              ["**Duplicate**", "Makes a copy and opens it. Use it to make a variation without touching the original."],
              ["**Bin icon**", "Deletes the email. Campaigns that already used it keep their own copy."],
            ],
          },
          { t: "p", text: "Under the name you see the subject line, when it was last edited, **ES/PT ready** when the Spanish and Portuguese copies exist, and **in N campaigns** when campaigns use it." },
        ],
      },
      {
        title: "Create a new email",
        blocks: [
          { t: "p", text: "Press **+ New email**. A chooser opens with, from top to bottom:" },
          {
            t: "list",
            items: [
              "**Write it with AI**: type what the email is about (e.g. \"Women's going-out looks for the weekend, dark and bold, give them their code, invite them to the store\") and press **Write it**.",
              "**Your templates**: emails you saved as templates (see the editor's **Save as template**). The bin on a template deletes the template only.",
              "**The CARBON pack**: 70 designs in four tabs: **Core (10)**, **Seasonal (20)** (the retail calendar), **Studio (10)** (signature effects) and **Bright (30)** (colour, and the automatic emails).",
              "**CARBON starters**: Blank, New collection, Editorial, Streetwear drop, Lookbook, Personal offer, Store visit. Click one to see it on a computer and a phone, then **Start with this** (or **Back**).",
              "**For automatic emails (Flows)**: Welcome, Welcome code reminder, Abandoned checkout, Thank you, We miss you. Their cart and order parts fill in per person when the flow sends.",
            ],
          },
          { t: "tip", text: "Pictures and products in a preview are examples from your catalog. You choose your own in the editor." },
        ],
      },
    ],
  },

  {
    id: "editor",
    title: "The email editor (drag and drop)",
    short: "Editor",
    intro:
      "Opens full screen when you edit an email. It saves by itself about a second after every change; what you see is what customers get.",
    parts: [
      {
        title: "Where everything is",
        blocks: [
          {
            t: "map",
            svg: MAP_EDITOR,
            legend: [
              "**Back arrow, name, save status.** The arrow saves and closes. Click the name to rename. Status: Saving / Saved / **Not saved, retry** (click it to retry).",
              "**Top-right buttons.** Clock = **Version history**; **Save as template**; **Check** (AI + rules check); **Preview and test**; **Done** (save and close).",
              "**The three icons on the left**: **+ Add content**, **palette = Edit styles** (colours, fonts, brand kit), **envelope = Subject line and preview text**.",
              "**The left panel.** Shows what you are adding, or the settings of whatever you clicked. **Hide** folds it away.",
              "**Undo, redo, desktop and phone view.** While you type, this becomes the text toolbar.",
              "**The email.** Click anything to select it (blue outline). Double-click text to type.",
              "**The block toolbar** (left of a selected block): drag handle, Edit text, Move up, Move down, Duplicate, Delete.",
              "**The section toolbar** (right of a selected section): drag handle, Move up, Move down, Duplicate section, **bookmark = Save section** (reuse it in any email), Delete section.",
            ],
          },
        ],
      },
      {
        title: "Add things",
        blocks: [
          {
            t: "steps",
            items: [
              "Click **+ Add content** (left icon). Tabs: **Basic**, **Pre-built**, **Saved**.",
              "**Basic → Blocks**: drag a block onto the email (a blue line shows where it lands), or click it to add it under the selected block.",
              "**Basic → Layout**: **Columns** or **Section** opens \"Configure column layout\": choose 1–4 columns and their widths (e.g. 33% | 67%), then **Add column layout**.",
              "**Pre-built**: ready sections (logo headers, heroes, product grids, personal code offer, visit the store, follow us…). Search or filter by tag, then click or drag one in.",
              "**Saved**: sections you saved with the bookmark button. Each email gets its own copy.",
            ],
          },
        ],
      },
      {
        title: "The blocks",
        blocks: [
          {
            t: "table",
            head: ["Block", "What it is for"],
            rows: [
              ["**Text**", "Words. Double-click to type. Has **Rewrite with AI** and **Send as a picture** (exact font in Gmail and Outlook; use it for headlines, not paragraphs)."],
              ["**Image**", "One picture: **Select image**, alt text, the link it opens, width and alignment."],
              ["**Hero picture**", "Big type over your photos, drawn as one sharp picture so every inbox shows it the same. See \"Hero pictures\" below."],
              ["**Button**", "A tappable button: text, link, colour, corners, width."],
              ["**Product**", "**Dynamic** (picked automatically: Newest arrivals, Newest for women, Newest for men, Most in stock, or This person's cart or order) or **Static** (you choose up to 9 with **Add products**). Only products with stock."],
              ["**Code**", "Each person's own Shopify code. The campaign or flow sets the offer and end date."],
              ["**Countdown**", "A live timer picture that ticks when the email is opened. Set **Ends (Orlando time)**."],
              ["**Split**", "Two cells side by side (text, picture or HTML)."],
              ["**Header bar**", "The CARBON logo and menu links."],
              ["**Social links**", "Instagram, Facebook, TikTok, YouTube, website icons."],
              ["**Video**", "Shows a thumbnail; tapping it opens the video (email apps can't play video)."],
              ["**Divider / Spacer**", "A line, or empty space."],
              ["**HTML**", "Your own code (scripts and forms are removed)."],
            ],
          },
          { t: "p", text: "Every block has two tabs in its panel: **Styles** (colours, padding, border) and **Display** (show it on **All devices**, **Desktop only** or **Mobile only**)." },
          { t: "tip", text: "Live product grids (Dynamic) fill themselves with today's in-stock products every time the email is sent, so old emails never show sold-out pieces." },
        ],
      },
      {
        title: "Change words, pictures and colours",
        blocks: [
          {
            t: "list",
            items: [
              "**Words**: double-click the text. The toolbar on top has Style (Heading 1–4, Body), font, size, bold/italic, colour, alignment, lists, **Link** and **Personal tags** (first name, the person's code, the offer, the code's end date, shop link).",
              "**First name**: Personal tags → First name → type what to show when we don't know the name (e.g. \"there\") → **Insert first name**.",
              "**Pictures**: click the picture → **Select image** or **Replace**. Tabs: **Image library** (Uploaded here, CARBON pictures from Shopify, Store photos, Logo; **Upload image** up to 10 MB), **Product images** (your in-stock catalog), **Import URL**.",
              "**Colours, fonts, page look**: palette icon (**Edit styles**). Change the page and content background, width, heading and body fonts, link colour and phone sizes.",
              "**Brand kit**: in Edit styles, **Save as brand kit** stores these styles; **Use brand kit here** applies them to any email in one click. New blank emails start with it. The round rainbow button in every colour field opens your brand colours.",
            ],
          },
        ],
      },
      {
        title: "Hero pictures",
        blocks: [
          {
            t: "steps",
            items: [
              "Click the hero. In the panel, **Design** chooses one of the layouts (Night Shift, Silhouette, The Edit, Monument, Coordinates, Brutal Grid, Red Alert, Teaser, Cut & Paste, Quiet, plus the pack's). Changing the design keeps your photos.",
              "Type the words in the text fields (Headline, Giant word, Top label… or Words 1, Words 2 for pack designs).",
              "Under **Photos**, pick a photo for each spot. An empty spot shows a grey stand-in with a hint like \"LOOK 01 full body\".",
              "Optional: **Cut out the background** under a photo removes a plain studio backdrop (about 15 seconds, saved in your pictures). **CARBON grade** adds contrast; **Accent colour** changes the highlight colour.",
            ],
          },
          { t: "warn", text: "An empty photo spot is left out of the sent email. **Check** lists every empty spot." },
        ],
      },
      {
        title: "Subject line, check, preview, test",
        blocks: [
          {
            t: "list",
            items: [
              "**Envelope icon**: **Subject line** (about 40–60 characters reads best on phones) and **Preview text** (the grey line after the subject). A campaign using this email starts with these.",
              "**Check**: shows \"Fix before sending\" (no subject, empty picture spot, button with no link, leftover example wording, unknown tags…) and \"Worth a look\". Click a problem to jump to it.",
              "**Preview and test**: Desktop / Mobile, English / ES / PT, **Send a test** (up to 5 addresses; empty = you; uses the sample code CB20-TEST00), the email's **Total size** (Gmail cuts emails over 102 KB), every link in the email, and **Translate** for the Spanish and Portuguese copies.",
              "**Version history** (clock): a version is kept each time you leave, and every 10 minutes. **Restore** brings one back (and can be undone).",
            ],
          },
        ],
      },
      {
        title: "Save and reuse",
        blocks: [
          {
            t: "list",
            items: [
              "**Save a section**: select a section → bookmark on its toolbar → name it. Find it in Add content → **Saved**.",
              "**Save as template** (top bar): new emails can start from it under + New email → **Your templates**.",
            ],
          },
        ],
      },
      {
        title: "Keyboard shortcuts",
        blocks: [
          {
            t: "table",
            head: ["Keys", "Does"],
            rows: [
              ["Ctrl+Z", "Undo (up to 100 steps)"],
              ["Ctrl+Shift+Z or Ctrl+Y", "Redo"],
              ["Ctrl+D", "Duplicate the selected block or section"],
              ["Delete / Backspace", "Delete the selected block or section (Ctrl+Z brings it back)"],
              ["Esc", "Stop typing; press again to unselect"],
            ],
          },
          { t: "tip", text: "On a Mac use Cmd instead of Ctrl. Shortcuts don't fire while you type in a box." },
        ],
      },
    ],
  },

  {
    id: "ai",
    title: "AI: every place it is, step by step",
    short: "AI",
    intro: "Four AI tools inside the email screens, plus translation. All of them work with words only.",
    parts: [
      {
        title: "1. Write a whole email with AI",
        blocks: [
          {
            t: "steps",
            items: [
              "**Emails → + New email**. The first box is **Write it with AI**.",
              "Describe the email in a sentence or two: who it's for, the mood, the products, whether to give a code, what to invite them to.",
              "Press **Write it** (\"Writing… about a minute\"). The new email opens in the editor, using your brand kit.",
              "Pick your own photos and change any words. Everything stays editable.",
            ],
          },
        ],
      },
      {
        title: "2. Rewrite a text",
        blocks: [
          {
            t: "steps",
            items: [
              "In the editor, click a **Text** block. The panel on the left shows **Rewrite with AI**.",
              "Press **Shorter**, **Bolder**, **Warmer**, **A bit longer** or **Fix spelling**, or type your own instruction (\"mention the weekend\") and press **Go**.",
              "Three options appear. Click one to use it. **Ctrl+Z** brings the old words back.",
            ],
          },
          { t: "p", text: "It works on Text blocks only (not buttons, heroes or product blocks). It reads the rest of the email so it fits." },
        ],
      },
      {
        title: "3. Subject line ideas",
        blocks: [
          {
            t: "steps",
            items: [
              "In the editor, click the **envelope** icon (Subject line and preview text).",
              "Optional: type a hint (\"playful, mention the store\").",
              "Press **Suggest subject lines** (later **More ideas**). Click a pair to fill both the subject and the preview text, then edit them if you like.",
            ],
          },
        ],
      },
      {
        title: "4. Check before sending",
        blocks: [
          {
            t: "p",
            text: "Press **Check** in the editor's top bar. Fixed rules check links, pictures and personal tags; the AI reads the words for spelling and grammar, made-up discounts or dates, other brand names (or \"Carbon Jeans\"), hype words and a subject that doesn't match. It does not judge the design.",
          },
        ],
      },
      {
        title: "5. Spanish and Portuguese",
        blocks: [
          {
            t: "p",
            text: "**Preview and test → Spanish and Portuguese → Translate**. The AI translates the words (Latin-American Spanish, Brazilian Portuguese); links, pictures, tags and prices stay exactly the same. Customers see a language bar at the top of the email. If you change the email later, press **Translate again**.",
          },
        ],
      },
      {
        title: "What the AI never does",
        blocks: [
          {
            t: "list",
            items: [
              "It never draws or changes pictures. (**Cut out the background** is a picture tool, not AI.)",
              "It never sends anything and never invents an offer: discounts always come from the campaign or flow settings.",
              "It never runs by itself, except one quiet background job: new pictures in Shopify Files are described once so the editor can suggest them.",
            ],
          },
          { t: "ai", text: "If the AI is busy you'll see \"The AI service answered … Try again in a minute.\" Nothing is lost; press the button again." },
        ],
      },
    ],
  },

  {
    id: "campaigns",
    tab: "campaigns",
    title: "Campaigns tab: send an email once",
    short: "Campaigns",
    intro: "A campaign sends one email to a list of people. Only a **Draft** can be changed; once you approve it, the email and the list are frozen.",
    parts: [
      {
        title: "Create and send a campaign",
        blocks: [
          {
            t: "steps",
            items: [
              "Type a name in **New campaign name** and press **New campaign** (or use **Use in a campaign** on an email card, or **Start it** in Calendar).",
              "**Email**: choose the email (the **Emails** button jumps to the Emails tab).",
              "**Subject** and **Preview text**. Use {{first_name}} for the person's name.",
              "**Who gets it**: \"Every customer we may email\" or \"Only subscribed in Shopify\", customers since / before a year, an optional **segment**, and \"not emailed in the last N days\". The live count shows how many people.",
              "Optional: **Give every person their own single-use Shopify code**: $ off or % off, the end date, a minimum order and the code's start letters (e.g. CB20).",
              "Press **Save changes**, look at the **Preview** (desktop and phone), then **Test email → Send test**.",
              "Under **Approve and send**: leave the date empty to send right away, or pick a date and time (Eastern). Press **Approve** → **Yes, approve**.",
            ],
          },
          { t: "warn", text: "If the email shows a code, the campaign must have an offer, and if the campaign has an offer, the email must show {{code}}. The red ✗ lines tell you exactly what's missing before Approve works." },
        ],
      },
      {
        title: "A/B test the subject line",
        blocks: [
          {
            t: "p",
            text: "Tick **A/B test the subject line**, write **Subject B**, choose the test group (10–50%), the wait (1–24 hours) and whether opens or clicks decide. The test group gets A or B at random; after the wait, everyone else gets the winner (a tie keeps A). You need at least 20 people.",
          },
        ],
      },
      {
        title: "After you approve",
        blocks: [
          {
            t: "table",
            head: ["Button", "What it does"],
            rows: [
              ["**Pause** / **Resume**", "Stops and restarts the sending."],
              ["**Back to draft**", "Only before sending has started: unfreezes it so you can change it."],
              ["**Cancel campaign**", "Stops for good. Nobody left in the queue gets it. Cannot be undone."],
              ["**Refresh sales**", "Reads code use and sales from Shopify now (it also does this every 3 hours)."],
            ],
          },
          {
            t: "p",
            text: "Statuses: **Draft → Approved · scheduled → Sending → Sent** (or Paused / Cancelled). Live numbers: Sent, Delivered, Opened, Clicked, Bounced, Spam reports, Unsubscribed, and Codes used · sales.",
          },
          {
            t: "list",
            items: [
              "Sending pauses by itself if bounces reach the limit in Settings (3%) or spam reports reach 0.1%.",
              "Each person is checked again right before their email: if they unsubscribed or bounced since, they are skipped.",
              "Nobody gets the same campaign twice.",
              "Campaigns have no Delete button; old ones simply stay in the list as a record.",
            ],
          },
        ],
      },
    ],
  },

  {
    id: "flows",
    tab: "flows",
    title: "Flows tab: automatic emails",
    short: "Flows",
    intro:
      "A flow sends emails by itself when something happens. CarbonWMS checks for new events every 5 minutes. A new flow is a **Draft** and sends nothing until you press **Turn on**; only things that happen **after** that count.",
    parts: [
      {
        title: "Where everything is",
        blocks: [
          {
            t: "map",
            svg: MAP_FLOW,
            legend: [
              "**Status**: LIVE (green), PAUSED (amber), DRAFT (grey).",
              "**Turn on / Pause / Resume**, **Back to draft** (everyone inside leaves), **Settings** (who, sending hours, re-entry), bin (delete).",
              "**The trigger**: what starts the flow. It can only be changed while the flow is a draft.",
              "**The + between steps**: add an **Email**, a **Time delay** or a **Stop if…**.",
              "**A step**: click it to change it. Emails show sent, opened, clicked and orders.",
              "**The step panel**: for an email: subject, which email, **Edit the email**, a personal code, and **Send test**.",
              "**Who is in it**: the latest 50 people and where they are.",
            ],
          },
        ],
      },
      {
        title: "Ready-made flows (+ New flow)",
        blocks: [
          {
            t: "table",
            head: ["Flow", "Starts when", "Emails"],
            rows: [
              ["**Welcome series**", "Someone signs up (pop-up or footer form)", "Welcome 1 after 1 day, Welcome 2 three days later. Stops if they order."],
              ["**Abandoned checkout**", "A checkout on shopcarbon.com isn't paid", "After 1 hour, and again after 1 day. Stops if they order."],
              ["**Thank you for your order**", "Any order, online or in the store", "A thank-you 2 hours later (not a receipt; Shopify still sends that)."],
              ["**We miss you (win-back)**", "No order for 90 days", "What's new, then 7 days later their own $20 code."],
              ["**Happy birthday**", "Their birthday (from Rewards)", "One email with their own 15% code."],
              ["**Shipped, then a review**", "An online order ships", "Shipped (with tracking), then 14 days later \"rate the fit\"."],
              ["**Looked but didn't add**", "A known shopper viewed products and left (4 hours)", "The pieces they looked at that are still in stock."],
              ["**Wishlist reminder**", "Their wishlist untouched for 7 days", "Their saved pieces."],
              ["**Back in stock**", "A wishlist item comes back", "One email."],
              ["**Price drop**", "A wishlist item gets 5%+ cheaper", "One email showing the old price."],
            ],
          },
          { t: "p", text: "Their emails are made for you from the CARBON pack. Or press **Build your own** for an empty flow." },
        ],
      },
      {
        title: "Change a flow",
        blocks: [
          {
            t: "steps",
            items: [
              "Click a flow in the list. Click a step to change it.",
              "**Time delay**: Wait N Minutes / Hours / Days.",
              "**Stop if…**: they placed an order since entering (online or in the store), or they clicked an email from this flow.",
              "**Email**: Step name (only you see it), **Subject line**, **Preview text**, **The email** (pick one of your emails), **Edit the email** (opens the editor), or **New email from a starter…**. Untick **Sends** to skip that email without deleting it.",
              "Optional: **Give each person their own Shopify code** (amount, $ or %, good for N days, minimum order). Put the code in the email with the \"Personal code offer\" section.",
              "**Send test** (empty = you). The test says [TEST], uses \"Maria\" as the name and a sample code that won't work at checkout.",
              "Changes save by themselves. When ready press **Turn on**. It stays greyed out until every email step has an email and a subject.",
            ],
          },
          { t: "warn", text: "**Pause** keeps people where they are and sends nothing; things that happen while paused don't enter it later. **Back to draft** takes everyone out." },
        ],
      },
      {
        title: "Flow settings",
        blocks: [
          {
            t: "list",
            items: [
              "**Who can get these emails**: Everyone who has not unsubscribed · Only people subscribed to marketing emails · About their own order (also to people who opted out of marketing).",
              "**Skip someone who got an email in the last … hours** (0 = never skip). Campaign emails count too.",
              "**Send from / Until** (Orlando time, default 9 AM–9 PM). An email due at night waits for the morning.",
              "**Can the same person go through it again?** No, only once, or Yes after N days.",
            ],
          },
          { t: "tip", text: "Unsubscribed, bounced and spam-complaining addresses never get anything, in any flow." },
        ],
      },
    ],
  },

  {
    id: "calendar",
    tab: "calendar",
    title: "Calendar tab: holidays and seasons",
    short: "Calendar",
    parts: [
      {
        blocks: [
          {
            t: "p",
            text: "The seasonal campaigns of the next 12 months with this year's dates: New Year, Valentine's Day, Presidents' Day, Spring Break, Spring Drop, Mother's Day, Summer Drop, Memorial Day, Father's Day, Summer Sale, 4th of July, Mid-Year Clearance, Back to School, Labor Day, Halloween, Singles' Day 11.11, Black Friday, Small Business Saturday, Cyber Monday, Holiday Gift Guide, Last Shipping Day.",
          },
          {
            t: "steps",
            items: [
              "Find the holiday. The badge says how many days are left (amber \"prepare now\" at 14 days or less).",
              "Press **Start it**: it makes the email from its CARBON template and a draft campaign, and opens the campaign.",
              "Swap in your photos and products (Edit the email), set the subject and audience, choose the send date under Approve and send, and approve.",
            ],
          },
          {
            t: "p",
            text: "Once started, the button becomes **Open campaign (draft)** etc. You get a phone/computer alert 14 days before each one (turn it on in **Settings › Alerts › Social & email**).",
          },
          { t: "tip", text: "Birthdays aren't on the calendar: they are automatic once the **Happy birthday** flow is on." },
        ],
      },
    ],
  },

  {
    id: "reports",
    tab: "reports",
    title: "Reports tab: what email earned",
    short: "Reports",
    parts: [
      {
        blocks: [
          { t: "p", text: "Campaigns and automatic emails together, for **30 days**, **90 days** or **1 year**." },
          {
            t: "table",
            head: ["Number", "Means"],
            rows: [
              ["**Emails sent**", "How many went out, and what % was delivered."],
              ["**Opened / Clicked**", "% of emails sent, and how many people."],
              ["**Orders after an email**", "Orders (online or in the store) within 5 days after someone got an email."],
              ["**Sales from email**", "The total of those orders, and dollars per email sent."],
              ["**Unsubscribed**", "% who unsubscribed within 3 days, plus bounced and spam counts."],
            ],
          },
          {
            t: "p",
            text: "Below: **Sales from email, per week** (hover a bar for details) and a table with every campaign and flow (tag **campaign** or **automatic**), sorted by sales.",
          },
          {
            t: "tip",
            text: "An order counts once, for the latest email the person got in the 5 days before it. In-store sales count when the customer's email is on the sale (Rewards).",
          },
        ],
      },
    ],
  },

  {
    id: "audience",
    tab: "contacts",
    title: "Audience tab: who can be emailed, and segments",
    short: "Audience",
    parts: [
      {
        title: "Contacts",
        blocks: [
          {
            t: "p",
            text: "Press **Sync contacts** to join your Rewards (store) customers and Shopify customers into one list. New sign-ups and buyers are added by the flows. The tiles show **Can be emailed**, **Subscribed in Shopify**, **Store customers (Rewards)** and **Online customers (Shopify)**.",
          },
          {
            t: "p",
            text: "**Never emailed**: fake or test addresses, staff addresses, typos (e.g. @gmial.com), unsubscribed, bounced, and people who marked an email as spam. An unsubscribe is also sent to Shopify, and a sync never re-subscribes anyone.",
          },
        ],
      },
      {
        title: "Segments",
        blocks: [
          {
            t: "steps",
            items: [
              "Press **+ New segment** (or one of the ready ideas: Best customers, Big spenders, Engaged, Lapsed, Never bought, Birthdays this month, Sleeping).",
              "Give it a name and add rules with **+ And another rule**. A person must match every rule.",
              "Watch the live count (\"N people right now\"), then **Save segment**.",
              "Use it in a campaign under **Who gets it → in the segment**.",
            ],
          },
          {
            t: "table",
            head: ["Rule", "Example"],
            rows: [
              ["Placed orders", "at least 3 orders in the last 365 days"],
              ["Has not ordered for a while", "no order in the last 90 days"],
              ["Never ordered", "—"],
              ["Spent at least", "$300 or more in the last 365 days"],
              ["Opened or clicked an email", "opened an email in the last 30 days"],
              ["Got emails but opened none", "in the last 60 days"],
              ["Rewards member", "is / is not a member"],
              ["Birthday month", "this month, next month, or a month"],
            ],
          },
          { t: "tip", text: "Click a segment to edit it; the bin deletes it. A campaign keeps its own frozen list once approved." },
        ],
      },
    ],
  },

  {
    id: "settings",
    tab: "settings",
    title: "Settings tab",
    short: "Settings",
    parts: [
      {
        title: "Sender",
        blocks: [
          {
            t: "table",
            head: ["Setting", "Now"],
            rows: [
              ["**From name**", "Carbon"],
              ["**From address**", "vip@shopcarbon.com (must be on a verified domain)"],
              ["**Replies go to**", "support@shopcarbon.com"],
              ["**Postal address in every footer**", "Required by law; shown in every email"],
              ["**Most emails per minute**", "Campaign sending speed"],
              ["**Pause a campaign by itself when bounces reach (%)**", "3%"],
              ["**Sending switched on**", "Off stops every campaign and flow email at once (they wait)"],
            ],
          },
          { t: "p", text: "Press **Save** after a change." },
        ],
      },
      {
        title: "Amazon SES (the sending service)",
        blocks: [
          {
            t: "p",
            text: "A checklist shows whether sending is ready: AWS keys, production access and your daily limit, shopcarbon.com verified, the bounce address, delivery tracking and DMARC. **Check again** refreshes it; **Set up Amazon SES** is safe to press again. If DNS records are listed, add them in NameBright exactly as shown (click a value to copy it).",
          },
        ],
      },
      {
        title: "Your brand library",
        blocks: [
          {
            t: "p",
            text: "Read-only: the real CARBON logo, every in-stock product with photos and prices, the store (address, hours, photos, directions) and CARBON pictures from Shopify, all ready inside the editor.",
          },
          { t: "tip", text: "Fonts, colours and the logo style live in the editor (palette icon → **Brand kit**), not here." },
        ],
      },
    ],
  },

  {
    id: "signup",
    title: "Sign-up forms (side menu)",
    short: "Sign-up forms",
    parts: [
      {
        blocks: [
          {
            t: "p",
            text: "The website pop-up and footer form that collect emails are in the side menu: **Email Marketing → Sign-up forms**. There you set the welcome discount (percent and how many days it lasts) and when the pop-up shows. Each sign-up gets their welcome code by email at once, then enters the **Welcome series** flow if it is on.",
          },
        ],
      },
    ],
  },

  {
    id: "howto",
    title: "How do I…",
    short: "How do I…",
    parts: [
      {
        blocks: [
          {
            t: "table",
            head: ["I want to…", "Do this"],
            rows: [
              ["Change a photo in an email", "Emails → Edit → click the picture → Replace (or for a hero: Photos → pick)."],
              ["Change a flow's email", "Flows → the flow → click the email step → **Edit the email**."],
              ["Give a discount to everyone in a campaign", "Campaign → tick **Give every person their own single-use Shopify code**; the email needs the \"Personal code offer\" section."],
              ["Send to my best customers only", "Audience → + New segment (Placed orders, at least 3) → Campaign → Who gets it → that segment."],
              ["See the email on a phone", "Editor → phone icon above the email, or Preview and test → Mobile."],
              ["Test before sending", "Editor → Preview and test → Send test; Campaign → Test email; Flow step → Send test."],
              ["Undo a mistake", "Ctrl+Z, or the clock icon → Version history → Restore."],
              ["Stop a campaign now", "Campaign → **Pause** (or **Cancel campaign** for good). To stop everything: Settings → untick Sending switched on."],
              ["Turn a flow off", "Flows → the flow → **Pause**."],
              ["Reuse a section", "Select it → bookmark → name it; later Add content → Saved."],
              ["Make my styles the default", "Editor → palette icon → **Save as brand kit**."],
              ["Know what email earned", "Reports tab."],
            ],
          },
        ],
      },
    ],
  },

  {
    id: "safety",
    title: "What keeps you safe",
    short: "Safety",
    parts: [
      {
        blocks: [
          {
            t: "list",
            items: [
              "Nothing reaches customers until you **Approve** a campaign or **Turn on** a flow. Tests are marked [TEST] and their codes don't work.",
              "Every email gets a footer with an **Unsubscribe** link and the postal address automatically. Unsubscribes, bounces and spam reports are never emailed again, and Shopify is updated.",
              "Campaigns pause by themselves on too many bounces or spam reports. Nobody gets the same campaign twice, and an interrupted email is never re-sent.",
              "Personal codes are single-use, once per customer, don't combine with other discounts, and stop working on their end date.",
              "Deleting an email never breaks a campaign that used it (the campaign keeps its own copy).",
            ],
          },
        ],
      },
    ],
  },
];
