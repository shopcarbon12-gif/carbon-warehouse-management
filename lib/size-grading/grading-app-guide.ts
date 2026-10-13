/**
 * CarbonGradingAI guide pictures (owner's ChatGPT flat lays, 2026-10-13), in
 * public/size-grading/guide/app/. Each garment type has a main picture the app
 * draws its lettered lines on (line ends in grading-app-guide-lines.json, from
 * scripts/grading-app-guide-lines.ts) and the other real Carbon products of
 * that type as "measured the same way" examples.
 */
import type { GradingProfileId } from "./grading-app-profiles";

const P = "/size-grading/guide/app";

export const GUIDE_MAIN: Record<GradingProfileId, string> = {
  tee: `${P}/tee-carbon-classic-t.webp`,
  jacket: `${P}/jacket-ashton-denim-jacket.webp`,
  campshirt: `${P}/campshirt-drake-shirt.webp`,
  tank: `${P}/tank-game-over-tank.webp`,
  camisole: `${P}/camisole-hallie-lace-tank.webp`,
  trousers: `${P}/jeans-jermone-jeans.webp`,
  shorts: `${P}/shorts-john-denim-shorts.webp`,
  skirt: `${P}/skirt-kimber-denim-skirt.webp`,
  "dress-sleeves-short": `${P}/dress-short-padded-dress.webp`,
  "dress-sleeves-long": `${P}/dress-long-top-buttoned-dress.webp`,
  "dress-sleeveless": `${P}/dress-sleeveless-callie-ruched-mini-dress.webp`,
  "dress-slip": `${P}/dress-slip-kiera-dress.webp`,
  onepiece: `${P}/romper-liany-romper.webp`,
};

export const GUIDE_EXAMPLES: Partial<Record<GradingProfileId, { image: string; label: string }[]>> = {
  tee: [
    { image: `${P}/tee-code-t-shirt.webp`, label: "Code T-Shirt — drop shoulder: the shoulder seam sits inside the bend" },
    { image: `${P}/longsleeve-time-never-shirt.webp`, label: "Time Never Shirt — long sleeve" },
    { image: `${P}/polo-ryan-polo-shirt.webp`, label: "Ryan Polo Shirt — polo" },
    { image: `${P}/blouse-fran-top.webp`, label: "Fran Top — long-sleeve top" },
    { image: `${P}/hoodie-apology-hoodie.webp`, label: "Apology Hoodie — hoodie, hood laid flat behind" },
    { image: `${P}/sweatshirt-you-matter-shirt.webp`, label: "You Matter Shirt — crewneck sweatshirt" },
    { image: `${P}/sweater-romeo-turtleneck.webp`, label: "Romeo Turtleneck Sweater — knit sweater" },
  ],
  jacket: [
    { image: `${P}/jacket-dennis-jacket.webp`, label: "Dennis Jacket — leather jacket" },
    { image: `${P}/coat-philip-puffer-coat.webp`, label: "Philip Puffer Coat — puffer coat" },
  ],
  tank: [{ image: `${P}/vest-randy-puffer-vest.webp`, label: "Randy Puffer Vest — vest" }],
  trousers: [
    { image: `${P}/joggers-live-the-moment-pants.webp`, label: "Live The Moment Pants — joggers" },
    { image: `${P}/leggings-maci-legging.webp`, label: "Maci Legging — leggings" },
  ],
  shorts: [{ image: `${P}/swim-landon-swimwear.webp`, label: "Landon Swimwear — swim shorts" }],
  onepiece: [
    { image: `${P}/bodysuit-amelia-bodysuit.webp`, label: "Amelia Bodysuit — bodysuit: no inseam, length to the bottom of the crotch" },
    { image: `${P}/overall-wayne-overall.webp`, label: "Wayne Overall — overall" },
  ],
};
