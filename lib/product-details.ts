/**
 * The product-page "Details" block and its Google Merchant Center equivalent:
 * Fabric, Care, and the model's height (owner, 2026-10-11: show the model's
 * height, never the size worn — that waits for each item's measurements).
 *
 * Text comes from the WMS (matrices.fabric_composition / care_instructions /
 * model profile) and is translated here from fixed word lists, so a Spanish or
 * Portuguese page never depends on a machine translator getting a fibre name
 * or a care sentence right.
 */

export type DetailLang = "en" | "es" | "pt-BR";

export type ProductDetailsInput = {
  fabric: string | null;
  care: string | null;
  modelHeight: string | null; // 5'8"
  modelGender: "female" | "male" | null;
};

const FIBRE: Record<string, { es: string; pt: string }> = {
  cotton: { es: "Algodón", pt: "Algodão" },
  polyester: { es: "Poliéster", pt: "Poliéster" },
  "micro polyester": { es: "Micropoliéster", pt: "Micropoliéster" },
  elastane: { es: "Elastano", pt: "Elastano" },
  spandex: { es: "Elastano", pt: "Elastano" },
  lycra: { es: "Lycra", pt: "Lycra" },
  viscose: { es: "Viscosa", pt: "Viscose" },
  viscon: { es: "Viscosa", pt: "Viscose" },
  modal: { es: "Modal", pt: "Modal" },
  acrylic: { es: "Acrílico", pt: "Acrílico" },
  wool: { es: "Lana", pt: "Lã" },
  nylon: { es: "Nailon", pt: "Náilon" },
  naylon: { es: "Nailon", pt: "Náilon" },
  linen: { es: "Lino", pt: "Linho" },
  lurex: { es: "Lúrex", pt: "Lurex" },
  metal: { es: "Metal", pt: "Metal" },
  polyurethane: { es: "Poliuretano", pt: "Poliuretano" },
  "pu leather": { es: "Piel sintética (PU)", pt: "Couro sintético (PU)" },
  pu: { es: "PU", pt: "PU" },
  pvc: { es: "PVC", pt: "PVC" },
  rubber: { es: "Goma", pt: "Borracha" },
  mesh: { es: "Malla", pt: "Tela" },
  fabric: { es: "Tela", pt: "Tecido" },
  "washed denim": { es: "Mezclilla lavada", pt: "Jeans lavado" },
  "knit fabric": { es: "Tejido de punto", pt: "Malha" },
  "printed canvas": { es: "Lona estampada", pt: "Lona estampada" },
  "faux fur": { es: "Piel sintética", pt: "Pelo sintético" },
  "faux leather": { es: "Piel sintética", pt: "Couro sintético" },
  satin: { es: "Satén", pt: "Cetim" },
  "faux suede": { es: "Ante sintético", pt: "Camurça sintética" },
  "snake-embossed pu": { es: "PU con textura de serpiente", pt: "PU com textura de cobra" },
  "mesh with rhinestones": { es: "Malla con pedrería", pt: "Tela com strass" },
  synthetic: { es: "Sintético", pt: "Sintético" },
  eva: { es: "EVA", pt: "EVA" },
};

const PART: Record<string, { es: string; pt: string }> = {
  upper: { es: "Exterior", pt: "Cabedal" },
  lining: { es: "Forro", pt: "Forro" },
  sole: { es: "Suela", pt: "Solado" },
  "heel tab": { es: "lengüeta del talón", pt: "aba do calcanhar" },
};

/** Care sentences used in the WMS, translated once. Unknown text stays English. */
const CARE: Record<string, { es: string; pt: string }> = {
  "Cold wash, hang dry.": { es: "Lavar en frío, secar colgado.", pt: "Lavar em água fria, secar pendurado." },
  "Keep dry. Wipe with a soft dry cloth; remove before swimming or showering.": {
    es: "Mantener seco. Limpiar con un paño suave y seco; quitar antes de nadar o ducharse.",
    pt: "Manter seco. Limpar com um pano macio e seco; retirar antes de nadar ou tomar banho.",
  },
  "Do not machine wash. Wipe clean with a damp cloth and air dry away from direct heat.": {
    es: "No lavar a máquina. Limpiar con un paño húmedo y secar al aire, lejos del calor directo.",
    pt: "Não lavar na máquina. Limpar com um pano úmido e secar ao ar, longe do calor direto.",
  },
  "Hand wash cold (or wool / delicate cycle). Do not wring; dry flat.": {
    es: "Lavar a mano en frío (o ciclo lana / delicado). No retorcer; secar en plano.",
    pt: "Lavar à mão em água fria (ou ciclo lã / delicado). Não torcer; secar na horizontal.",
  },
  "Rinse in cold fresh water after each use. Hand wash cold; dry in the shade.": {
    es: "Enjuagar con agua dulce fría después de cada uso. Lavar a mano en frío; secar a la sombra.",
    pt: "Enxaguar em água doce fria após cada uso. Lavar à mão em água fria; secar à sombra.",
  },
  "Dry clean recommended, or hand wash cold. Hang to dry; steam to remove creases.": {
    es: "Se recomienda limpieza en seco, o lavar a mano en frío. Secar colgado; usar vapor para quitar arrugas.",
    pt: "Recomenda-se lavagem a seco, ou lavar à mão em água fria. Secar pendurado; usar vapor para tirar vincos.",
  },
  "Hand wash cold or delicate cycle in a mesh bag. Hang dry; do not tumble dry.": {
    es: "Lavar a mano en frío o en ciclo delicado dentro de una bolsa de malla. Secar colgado; no usar secadora.",
    pt: "Lavar à mão em água fria ou no ciclo delicado dentro de um saco de rede. Secar pendurado; não usar secadora.",
  },
  "Hand wash cold, inside out. Do not wring or tumble dry; dry flat. Do not iron.": {
    es: "Lavar a mano en frío, del revés. No retorcer ni usar secadora; secar en plano. No planchar.",
    pt: "Lavar à mão em água fria, do avesso. Não torcer nem usar secadora; secar na horizontal. Não passar.",
  },
  "Do not wash. Wipe with a damp cloth.": { es: "No lavar. Limpiar con un paño húmedo.", pt: "Não lavar. Limpar com um pano úmido." },
  "Do not machine wash. Wipe with a damp cloth; hang to dry away from heat.": {
    es: "No lavar a máquina. Limpiar con un paño húmedo; secar colgado, lejos del calor.",
    pt: "Não lavar na máquina. Limpar com um pano úmido; secar pendurado, longe do calor.",
  },
  "Spot clean only. Do not machine wash; air dry on a rounded form to keep the shape.": {
    es: "Limpiar solo las manchas. No lavar a máquina; secar al aire sobre una forma redondeada para mantener la forma.",
    pt: "Limpar apenas as manchas. Não lavar na máquina; secar ao ar sobre uma forma arredondada para manter o formato.",
  },
  "Cold gentle wash with the fur trim removed, or spot clean the fur. Air dry.": {
    es: "Lavado suave en frío sin el ribete de piel, o limpiar la piel solo en las manchas. Secar al aire.",
    pt: "Lavagem suave em água fria sem o acabamento de pelo, ou limpar o pelo apenas nas manchas. Secar ao ar.",
  },
  "Wipe clean with a soft cloth.": { es: "Limpiar con un paño suave.", pt: "Limpar com um pano macio." },
  "Spot clean only. Brush the fur gently; do not machine wash.": {
    es: "Limpiar solo las manchas. Cepillar la piel con suavidad; no lavar a máquina.",
    pt: "Limpar apenas as manchas. Escovar o pelo com cuidado; não lavar na máquina.",
  },
  "Rinse with water and air dry.": { es: "Enjuagar con agua y secar al aire.", pt: "Enxaguar com água e secar ao ar." },
};

function tr(map: Record<string, { es: string; pt: string }>, key: string, lang: DetailLang): string | null {
  if (lang === "en") return key;
  const hit = map[key.toLowerCase()] ?? map[key];
  if (!hit) return null;
  return lang === "es" ? hit.es : hit.pt;
}

/** "97% Cotton, 3% Elastane" → "97% Algodón, 3% Elastano"; shoes "Upper: PU, …" by part. */
export function translateFabric(fabric: string, lang: DetailLang): string {
  if (lang === "en") return fabric;
  const word = (w: string) => {
    const m = w.trim().match(/^(.*?)(\s*\((?:heel tab):\s*(.*?)\))?$/i);
    const base = (m?.[1] ?? w).trim();
    let out = tr(FIBRE, base, lang) ?? base;
    if (m?.[2]) out += ` (${tr(PART, "heel tab", lang)}: ${tr(FIBRE, m[3].trim(), lang) ?? m[3].trim()})`;
    return out;
  };
  return fabric
    .split(",")
    .map((part) => {
      const p = part.trim();
      const pct = p.match(/^(\d+(?:[.,]\d+)?%)\s*(.+)$/);
      if (pct) return `${pct[1]} ${word(pct[2])}`;
      const lab = p.match(/^(Upper|Lining|Sole):\s*(.+)$/i);
      if (lab) {
        const items = lab[2].split(/\s+and\s+/i).map(word).join(lang === "es" ? " y " : " e ");
        return `${tr(PART, lab[1].toLowerCase(), lang)}: ${items}`;
      }
      return word(p);
    })
    .join(", ");
}

export function translateCare(care: string, lang: DetailLang): string {
  return tr(CARE, care.trim(), lang) ?? care.trim();
}

/** The height line — never the size worn. */
export function modelHeightLine(height: string, gender: "female" | "male" | null, lang: DetailLang): string {
  if (lang === "es") return `${gender === "male" ? "El modelo mide" : "La modelo mide"} ${height}`;
  if (lang === "pt-BR") return `${gender === "male" ? "O modelo tem" : "A modelo tem"} ${height}`;
  return `Model is ${height}`;
}

export const DETAIL_LABELS: Record<DetailLang, { section: string; fabric: string; care: string; model: string }> = {
  en: { section: "Details", fabric: "Fabric", care: "Care", model: "Model" },
  es: { section: "Detalles", fabric: "Tejido", care: "Cuidado", model: "Modelo" },
  "pt-BR": { section: "Detalhes", fabric: "Tecido", care: "Cuidados", model: "Modelo" },
};

/**
 * Google `material`: up to three materials, joined by "/", largest share first
 * ("Cotton/Elastane"); for shoes the upper's material. Google's limit is 200.
 */
export function googleMaterial(fabric: string, lang: DetailLang): string {
  const f = translateFabric(fabric, lang);
  const upper = f.match(/^(?:Upper|Exterior|Cabedal):\s*([^,]+)/i);
  if (upper) return upper[1].split(/\s+(?:and|y|e)\s+/i)[0].replace(/\s*\(.*\)$/, "").trim().slice(0, 200);
  const names = f
    .split(",")
    .map((p) => p.trim().replace(/^\d+(?:[.,]\d+)?%\s*/, ""))
    .filter(Boolean);
  return [...new Set(names)].slice(0, 3).join("/").slice(0, 200);
}

export type GoogleProductDetail = { sectionName: string; attributeName: string; attributeValue: string };

/** Google `productDetails` for one language. */
export function googleProductDetails(d: ProductDetailsInput, lang: DetailLang): GoogleProductDetail[] {
  const L = DETAIL_LABELS[lang];
  const out: GoogleProductDetail[] = [];
  if (d.fabric) out.push({ sectionName: L.section, attributeName: L.fabric, attributeValue: translateFabric(d.fabric, lang).slice(0, 1000) });
  if (d.care) out.push({ sectionName: L.section, attributeName: L.care, attributeValue: translateCare(d.care, lang).slice(0, 1000) });
  if (d.modelHeight) out.push({ sectionName: L.section, attributeName: L.model, attributeValue: modelHeightLine(d.modelHeight, d.modelGender, lang) });
  return out;
}
