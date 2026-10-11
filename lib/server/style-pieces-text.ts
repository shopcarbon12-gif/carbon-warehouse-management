/**
 * "Back: large white silhouette … Sleeves and back plain" — a plain-claim for a
 * side the same line describes a print on. The generator would be free to drop
 * the print, so the contradicted claim goes (the print wins: it was seen).
 */
const SIDES = ["back", "front", "sleeves", "inner sides", "outer sides"];
const PRINTED = /\b(print|graphic|text|logo|silhouette|image|lettering|splatter|stripe|pattern|figure)\b/i;
export function withoutContradictedPlain(v: string): string {
  let out = v;
  for (const side of SIDES) {
    const described = new RegExp(`\\b${side}\\s*:\\s*([^.;]*)`, "i").exec(out);
    if (!described || /^\s*plain\b/i.test(described[1]) || !PRINTED.test(described[1])) continue;
    // "Sleeves and back plain" → "Sleeves plain"; ", back plain" / "back plain" → removed.
    out = out
      .replace(new RegExp(`\\s+and\\s+${side}\\s+plain\\b`, "gi"), " plain")
      .replace(new RegExp(`[,;]?\\s*\\b${side}\\s+plain\\b`, "gi"), "");
  }
  return out.replace(/\s{2,}/g, " ").replace(/\s+([.,;])/g, "$1").replace(/[,;]\s*$/, "").trim();
}
