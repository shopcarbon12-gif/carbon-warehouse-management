/**
 * CarbonWMS Creative — every job kind and the code that runs it (one registry, so jobs.ts stays
 * free of imports). NO job here generates pictures or video on a timer: the only scheduled job is
 * Radar's nightly collection (radar_nightly, no paid AI) and its one-time tagging batch.
 */
import type { JobHandler } from "./jobs";
import { radarNightly, radarRetention, radarSource, radarTag } from "./radar/run";
import { twinBuild } from "./twin";
import { conceptThumbs, projectConcepts, projectDraft, projectFinal, projectShots, projectStills } from "./pipeline";
import { campaignPack, projectCutdown } from "./campaign";
import { projectRerender } from "./chat";
import { refreshResults } from "./learning";

const learningRefresh: JobHandler = async (pool, job) => {
  const n = await refreshResults(pool, job.tenant_id);
  return { status: "done", progress: `${n} posts' results refreshed` };
};

export const HANDLERS: Record<string, JobHandler> = {
  radar_nightly: radarNightly,
  radar_source: radarSource,
  radar_tag: radarTag,
  radar_retention: radarRetention,
  twin_build: twinBuild,
  project_concepts: projectConcepts,
  concept_thumbs: conceptThumbs,
  project_shots: projectShots,
  project_stills: projectStills,
  project_draft: projectDraft,
  project_final: projectFinal,
  project_rerender: projectRerender,
  project_cutdown: projectCutdown,
  campaign_pack: campaignPack,
  learning_refresh: learningRefresh,
};

/** Jobs that never spend on image / video generation (the audit list for "no background generation"). */
export const SCHEDULED_KINDS = ["radar_nightly", "radar_source", "radar_tag", "radar_retention", "learning_refresh"] as const;
