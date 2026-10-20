import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { GRADING_PROFILES, hardKeys } from "@/lib/size-grading/grading-app-profiles";
import { GUIDE_EXAMPLES, GUIDE_MAIN } from "@/lib/size-grading/grading-app-guide";
import guideLines from "@/lib/size-grading/grading-app-guide-lines.json";
import { PLAUSIBLE } from "@/lib/size-grading/pom-definitions";
import { latestRelease } from "@/lib/server/grading-app";
import { gradingAppAgentConfig } from "@/lib/server/size-grading-agent";
import { isDropboxConfigured } from "@/lib/server/dropbox-upload";
import { toAbsolutePublicUrl } from "@/lib/server/resolve-public-origin";

export const dynamic = "force-dynamic";

/**
 * CarbonGradingAI start-up config. The phone downloads this every time it
 * opens: garment types, their point lists and definitions, laying
 * instructions, which points the AI assist places, the plausible ranges, the
 * supported phones and the newest APK. Change any of it here (or in
 * lib/size-grading/grading-app-profiles.ts) and the app follows on its next
 * start — no app update.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  const ai = gradingAppAgentConfig();
  const rel = pool ? await latestRelease(pool) : null;
  const scope = (process.env.GRADING_APP_AI_SCOPE || "hard").trim() === "all" ? "all" : "hard";
  return NextResponse.json({
    version: 1,
    user: { email: session.email, role: session.role },
    profiles: GRADING_PROFILES.map((p) => ({
      ...p,
      aiKeys: scope === "all" ? p.points.map((x) => x.key) : hardKeys(p),
      guide: {
        image: GUIDE_MAIN[p.id],
        lines: (guideLines as unknown as Record<string, Record<string, [[number, number], [number, number]]>>)[p.id] ?? {},
        examples: GUIDE_EXAMPLES[p.id] ?? [],
      },
    })),
    plausible: PLAUSIBLE,
    ai: ai ? { enabled: true, model: ai.model, scope } : { enabled: false, model: null, scope },
    capture: {
      // Working distance; the Note10+ depth sensor is accurate across it. 45 cm lets
      // small items (tees, shorts) be shot closer — the owner could not read the
      // screen held at 110 cm (2026-10-20). Hold 0.8 s (was 1.2 s).
      distanceCm: [45, 120],
      idealDistanceCm: [55, 110],
      maxTiltDeg: 8,
      holdStillMs: 800,
      pairLimitCm: 1,
    },
    devices: {
      // Rear time-of-flight depth sensor — the only phones the app measures on (plan v3).
      supported: ["SM-N975", "SM-N976", "SM-G986", "SM-G988"],
      names: { "SM-N975": "Galaxy Note10+", "SM-N976": "Galaxy Note10+ 5G", "SM-G986": "Galaxy S20+ 5G", "SM-G988": "Galaxy S20 Ultra 5G" },
    },
    storage: { dropbox: isDropboxConfigured(), dropboxFolder: "elior perez › Carbon › Elior › CarbonGradingAI" },
    app: rel ? { latestVersion: rel.version, downloadUrl: toAbsolutePublicUrl(req, rel.apkUrl), sha1: rel.sha1, notes: rel.notes } : null,
    links: {
      studio: "/inventory/catalog?matrix={matrixId}&mtab=studio",
      seo: "/inventory/catalog?matrix={matrixId}&mtab=seo",
      review: "/inventory/size-grading/review",
      cutGroups: "/inventory/size-grading/cut-groups",
    },
  });
}
