/**
 * Visitors — pure helpers (unit-tested in scripts/test-visitors.ts).
 */

/** "Maria Lopez" → "Maria L." (null when there is no first name). */
export function shortName(first: string, last: string): string | null {
  const f = (first || "").trim();
  const l = (last || "").trim();
  if (!f) return null;
  return l ? `${f} ${l[0].toUpperCase()}.` : f;
}

/** Phone / tablet / computer, the system, and the browser or in-app browser. */
export function describeDevice(ua: string): { device: string; os: string; browser: string } {
  const u = ua || "";
  const device = /iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(u)
    ? "tablet"
    : /Mobi|iPhone|iPod|Android|Windows Phone/i.test(u)
      ? "phone"
      : "computer";
  const os = /iPhone|iPad|iPod/i.test(u)
    ? "iOS"
    : /Android/i.test(u)
      ? "Android"
      : /CrOS/i.test(u)
        ? "ChromeOS"
        : /Windows/i.test(u)
          ? "Windows"
          : /Mac OS X|Macintosh/i.test(u)
            ? "macOS"
            : /Linux/i.test(u)
              ? "Linux"
              : "Other";
  const browser = /Instagram/i.test(u)
    ? "Instagram app"
    : /FBAN|FBAV|FB_IAB/i.test(u)
      ? "Facebook app"
      : /musical_ly|TikTok|BytedanceWebview/i.test(u)
        ? "TikTok app"
        : /Snapchat/i.test(u)
          ? "Snapchat app"
          : /Pinterest/i.test(u)
            ? "Pinterest app"
            : /Edg(A|iOS)?\//i.test(u)
              ? "Edge"
              : /SamsungBrowser/i.test(u)
                ? "Samsung Internet"
                : /OPR\/|Opera/i.test(u)
                  ? "Opera"
                  : /CriOS|Chrome\//i.test(u)
                    ? "Chrome"
                    : /FxiOS|Firefox\//i.test(u)
                      ? "Firefox"
                      : /Safari\//i.test(u)
                        ? "Safari"
                        : "Other";
  return { device, os, browser };
}

/** What the page calls a visitor: the owner's nickname, then who they are, then a short id. */
export function visitorLabel(v: { nickname?: string | null; customer_name?: string | null; email?: string | null; visitor_id: string }): string {
  return (
    v.nickname?.trim() ||
    v.customer_name?.trim() ||
    v.email?.trim() ||
    `Visitor ${v.visitor_id.replace(/[^a-z0-9]/gi, "").slice(0, 6).toUpperCase()}`
  );
}

/** Nickname / note as the owner typed them: trimmed, capped, empty → null. */
export function cleanLabel(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim().slice(0, max);
  return s || null;
}
