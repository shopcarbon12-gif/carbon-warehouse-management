/**
 * CarbonWMS Email Editor — ready-made CARBON sections (the "Pre-built" tab) and starter emails.
 * Our own designs, built from the editor's blocks, so everything in them stays editable.
 */
import { LOGO, INSTAGRAM, SHOP_URL, defaultStyles, newBlock, newSection, pad, type Block, type EmailDoc, type Section } from "./types";

const STORE_OUT = "https://cdn.shopify.com/s/files/1/0680/6572/2620/files/ChatGPT_Image_Jun_12_2026_12_43_51_AM.png?v=1781252379";
const STORE_IN = "https://cdn.shopify.com/s/files/1/0680/6572/2620/files/ChatGPT_Image_Jun_12_2026_12_30_10_AM.png?v=1781252368";
const DIRECTIONS = "https://www.google.com/maps/dir/?api=1&destination=6250+Edgewater+Drive%2C+Suite+100%2C+Orlando%2C+FL+32810";

function text(html: string, p = pad(9, 32)): Block {
  const b = newBlock("text");
  if (b.type === "text") {
    b.html = html;
    b.pad = p;
  }
  return b;
}
function btn(label: string, href: string, opts: { color?: string; textColor?: string; full?: boolean } = {}): Block {
  const b = newBlock("button");
  if (b.type === "button") {
    b.text = label;
    b.href = href;
    if (opts.color) b.color = opts.color;
    if (opts.textColor) b.font.color = opts.textColor;
    b.full = !!opts.full;
    b.pad = pad(12, 32);
  }
  return b;
}
function image(src: string | null, alt = "", p = pad(0)): Block {
  const b = newBlock("image");
  if (b.type === "image") {
    b.src = src;
    b.alt = alt;
    b.pad = p;
  }
  return b;
}
const spacer = (h: number): Block => {
  const b = newBlock("spacer");
  if (b.type === "spacer") b.height = h;
  return b;
};
const one = (blocks: Block[], patch: Partial<Section> = {}): Section => ({ ...newSection([100], [blocks]), ...patch });

export type Prebuilt = { id: string; name: string; tags: string[]; make: () => Section | Section[] };

export const PREBUILT: Prebuilt[] = [
  { id: "header", name: "Logo header", tags: ["Header"], make: () => one([newBlock("header")]) },
  {
    id: "header-dark",
    name: "Logo header, dark",
    tags: ["Header"],
    make: () => {
      const h = newBlock("header");
      if (h.type === "header") {
        h.logo = LOGO.white;
        h.linkFont.color = "#FFFFFF";
      }
      return one([h], { bg: "#111111" });
    },
  },
  {
    id: "announce",
    name: "Announcement bar",
    tags: ["Header"],
    make: () =>
      one([text(`<p style="text-align:center;font-size:12px;letter-spacing:2px;color:#FFFFFF;"><strong>FREE U.S. &amp; CANADA SHIPPING OVER $125</strong></p>`, pad(10, 16))], { bg: "#111111" }),
  },
  {
    id: "hero",
    name: "Hero: photo, headline, button",
    tags: ["Hero"],
    make: () =>
      one([
        image(null, "The new collection"),
        spacer(28),
        text(`<h1 style="text-align:center;">The new collection</h1>`),
        text(`<p style="text-align:center;">One line about what is new and why it is worth a look.</p>`),
        btn("SHOP NOW", SHOP_URL),
        spacer(28),
      ]),
  },
  {
    id: "hero-dark",
    name: "Hero on black",
    tags: ["Hero"],
    make: () =>
      one(
        [
          spacer(36),
          text(`<p style="text-align:center;font-size:12px;letter-spacing:3px;color:#BDBDBD;">AW2026 · NEW COLLECTION</p>`),
          text(`<h1 style="text-align:center;color:#FFFFFF;">Worth the detour</h1>`),
          image(null, "Campaign photo", pad(18, 0)),
          btn("SHOP AW2026", SHOP_URL, { color: "#FFFFFF", textColor: "#111111" }),
          spacer(36),
        ],
        { bg: "#111111" },
      ),
  },
  {
    id: "hero-editorial",
    name: "Editorial hero (Bodoni)",
    tags: ["Hero", "Fonts"],
    make: () =>
      one([
        spacer(40),
        text(`<p style="text-align:center;font-family:'Montserrat';font-size:11px;letter-spacing:6px;color:#6B6B6B;">AUTUMN · WINTER 2026</p>`),
        text(`<h1 style="text-align:center;font-family:'Bodoni Moda';font-style:italic;font-weight:400;font-size:58px;line-height:1.05;">Worth the detour</h1>`, pad(6, 32)),
        text(`<p style="text-align:center;font-family:'Montserrat';font-size:14px;line-height:1.7;color:#444444;">The new collection, made for the long way around.</p>`, pad(10, 64)),
        image(null, "Campaign photo", pad(24, 0)),
        btn("DISCOVER", SHOP_URL),
        spacer(36),
      ], { bg: "#F7F4EF" }),
  },
  {
    id: "drop",
    name: "Streetwear drop (Bebas)",
    tags: ["Hero", "Fonts"],
    make: () =>
      one([
        spacer(28),
        text(`<p style="text-align:center;font-family:'Space Mono';font-size:12px;letter-spacing:3px;color:#BDBDBD;">DROP 01 · 11.14 · 10 AM</p>`),
        text(`<h1 style="text-align:center;font-family:'Bebas Neue';font-weight:400;font-size:112px;line-height:0.9;color:#FFFFFF;letter-spacing:2px;">NEW HEAT</h1>`, pad(0, 18)),
        image(null, "The drop", pad(18, 0)),
        btn("SHOP THE DROP", SHOP_URL, { color: "#E8FF3A", textColor: "#111111", full: true }),
        spacer(28),
      ], { bg: "#0E0E0E" }),
  },
  {
    id: "signature",
    name: "Signature note (script)",
    tags: ["Text", "Fonts"],
    make: () =>
      one([
        text(`<p style="font-family:'Cormorant Garamond';font-size:20px;line-height:1.6;text-align:center;">Every piece in this collection was picked by hand in our Orlando showroom. Come by, try it on, and tell us what you think.</p>`, pad(32, 56)),
        text(`<p style="text-align:center;font-family:'Great Vibes';font-size:44px;line-height:1.1;">With love, Carbon</p>`, pad(4, 32)),
        spacer(24),
      ]),
  },
  { id: "headline", name: "Headline and text", tags: ["Text"], make: () => one([text(`<h2>A short headline</h2>`, pad(24, 32)), text(`<p>Two or three sentences in CARBON's voice: short, confident, warm.</p>`, pad(0, 32))]) },
  {
    id: "products-3",
    name: "3 products (newest)",
    tags: ["Products"],
    make: () => {
      const p = newBlock("product");
      if (p.type === "product") {
        p.perRow = 3;
        p.rows = 1;
      }
      return one([text(`<h3 style="text-align:center;">New in</h3>`, pad(24, 32)), p]);
    },
  },
  {
    id: "products-6",
    name: "6 products grid",
    tags: ["Products"],
    make: () => {
      const p = newBlock("product");
      if (p.type === "product") {
        p.perRow = 3;
        p.rows = 2;
        p.showButton = false;
      }
      return one([text(`<h3 style="text-align:center;">Shop the edit</h3>`, pad(24, 32)), p, btn("SEE EVERYTHING NEW", SHOP_URL)]);
    },
  },
  {
    id: "look",
    name: "Look: photo beside its pieces",
    tags: ["Products"],
    make: () => {
      const p = newBlock("product");
      if (p.type === "product") {
        p.source = "static";
        p.perRow = 1;
        p.orientation = "image-left";
        p.imgRatio = "auto";
        p.showButton = false;
      }
      const s = newSection([50, 50], [[image(null, "The look", pad(0))], [text(`<h3>Look name</h3><p>One line on how to wear it.</p>`, pad(9, 9)), p]]);
      s.pad = pad(24, 18);
      s.gap = 18;
      s.valign = "middle";
      return s;
    },
  },
  {
    id: "split",
    name: "Photo and text side by side",
    tags: ["Content"],
    make: () => one([newBlock("split")]),
  },
  {
    id: "two-photos",
    name: "Two photos",
    tags: ["Content"],
    make: () => {
      const s = newSection([50, 50], [[image(null)], [image(null)]]);
      s.gap = 12;
      s.pad = pad(12, 18);
      return s;
    },
  },
  {
    id: "code",
    name: "Personal code offer",
    tags: ["Offer"],
    make: () => one([newBlock("code")], { bg: "#F3F1EC" }),
  },
  {
    id: "store",
    name: "Visit the store",
    tags: ["Store"],
    make: () => {
      const photos = newSection([50, 50], [[image(STORE_OUT, "The CARBON store")], [image(STORE_IN, "Inside the CARBON store")]]);
      photos.gap = 12;
      photos.pad = pad(0, 18);
      return [
        one([text(`<h3>Now open in Orlando</h3><p>CARBON Showroom · 6250 Edgewater Drive, Suite 100, Orlando, FL 32810</p>`, pad(24, 32))]),
        photos,
        one([text(`<p style="font-size:14px;">Mon–Tue 12–7 PM · Wed closed · Thu–Sat 12–7 PM · Sun closed<br>(407) 773-1399</p>`, pad(12, 32)), btn("GET DIRECTIONS", DIRECTIONS), spacer(16)]),
      ];
    },
  },
  {
    id: "follow",
    name: "Follow us",
    tags: ["Footer"],
    make: () => one([text(`<p style="text-align:center;"><strong>Follow @shopcarbon</strong></p>`, pad(24, 32)), newBlock("social"), spacer(12)]),
  },
];

/** The sections of a pre-built (some, like the store, are several sections). */
export function prebuiltSections(id: string): Section[] {
  const p = PREBUILT.find((x) => x.id === id);
  if (!p) return [];
  const out = p.make();
  return Array.isArray(out) ? out : [out];
}

/* ----------------------------------------------------------------- starters */

export type Starter = { id: string; name: string; description: string; make: () => EmailDoc };

const doc = (ids: string[], styles = defaultStyles()): EmailDoc => ({ v: 1, styles, sections: ids.flatMap(prebuiltSections) });

/** The streetwear starter: everything light on black. */
function darkDrop(): EmailDoc {
  const st = defaultStyles();
  st.pageBg = "#0E0E0E";
  st.contentBg = "#0E0E0E";
  for (const k of ["body", "h1", "h2", "h3", "h4"] as const) st.text[k] = { ...st.text[k], color: "#FFFFFF" };
  st.text.h3 = { ...st.text.h3, family: "Bebas Neue", size: 40, bold: false, ls: 1 };
  st.link = { ...st.link, color: "#FFFFFF" };
  const d = doc(["header-dark", "drop", "products-6", "code", "follow"], st);
  for (const sec of d.sections)
    for (const c of sec.cols)
      for (const b of c.blocks) {
        if (b.type === "product") {
          b.nameFont = { ...b.nameFont, color: "#FFFFFF", family: "Space Mono", size: 12 };
          b.priceFont = { ...b.priceFont, color: "#E8FF3A", family: "Space Mono" };
        }
        if (b.type === "social") b.color = "white";
        if (b.type === "button" && b.color === "#111111") {
          b.color = "#FFFFFF";
          b.font = { ...b.font, color: "#111111" };
        }
      }
  return d;
}

export const STARTERS: Starter[] = [
  { id: "blank", name: "Blank", description: "Logo header and an empty section.", make: () => ({ ...doc(["header"]), sections: [...prebuiltSections("header"), newSection()] }) },
  {
    id: "collection",
    name: "New collection",
    description: "Hero, products, your code, the store, follow us.",
    make: () => doc(["announce", "header", "hero", "products-3", "code", "store", "follow"]),
  },
  { id: "editorial", name: "Editorial", description: "Bodoni hero on cream, products, a signed note, the store.", make: () => doc(["header", "hero-editorial", "products-3", "signature", "store", "follow"]) },
  { id: "drop", name: "Streetwear drop", description: "Black page, a huge Bebas headline, 6 products, your code.", make: () => darkDrop() },
  { id: "lookbook", name: "Lookbook", description: "Dark hero, three looks with their pieces, follow us.", make: () => doc(["header", "hero-dark", "look", "look", "look", "follow"]) },
  { id: "offer", name: "Personal offer", description: "A short note and the person's own code.", make: () => doc(["header", "headline", "code", "products-6", "follow"]) },
  { id: "store", name: "Store visit", description: "Invite people to the Orlando showroom.", make: () => doc(["header", "headline", "store", "follow"]) },
];

export { INSTAGRAM };
