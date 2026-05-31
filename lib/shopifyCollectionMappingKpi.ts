export type ShopifyCollectionMappingDecision = "AUTO_MAPPED" | "SUGGESTED" | "MANUAL_REVIEW";
export type ShopifyCollectionMappingSyncStatus = "REVIEW" | "REMOVAL_PENDING" | "ADD_PENDING" | "SYNCED";
export type ShopifyCollectionMappingActionStatus = "PROCESSED" | "FAILED" | "";

export const KPI_NEEDS_REVIEW_UNION_FILTER = "needs-review-kpi-union" as const;

export type ShopifyCollectionMappingQueueTab =
  | "all"
  | "needs-review"
  | typeof KPI_NEEDS_REVIEW_UNION_FILTER
  | "suggestion-ready"
  | "manual-changes"
  | "ready-push"
  | "push-failed"
  | "synced";

export type ShopifyCollectionMappingRowWorkflowInput = {
  mappingDecision?: ShopifyCollectionMappingDecision | "";
  collectionSyncStatus?: ShopifyCollectionMappingSyncStatus | "";
  actionStatus?: ShopifyCollectionMappingActionStatus | string | null;
  suggestionReady: boolean;
  /** High-confidence path/title conflicts (negative layer) — requires human eye like visible suggestions. */
  conflictSignals?: boolean;
  manualChanges: boolean;
  isReviewed?: boolean;
  currentMatchesFinal?: boolean;
};

export type ShopifyCollectionMappingPrimaryStatus = "needs-review" | "ready-push" | "push-failed" | "synced";
export type ShopifyCollectionMappingStatusBadgeTone =
  | "review"
  | "add-pending"
  | "removal-pending"
  | "failed"
  | "synced";

export type ShopifyCollectionMappingRowWorkflow = {
  mappingDecision: ShopifyCollectionMappingDecision;
  collectionSyncStatus: ShopifyCollectionMappingSyncStatus;
  actionStatus: ShopifyCollectionMappingActionStatus;
  isReviewed: boolean;
  currentMatchesFinal: boolean;
  requiresHumanEye: boolean;
  baseNeedsReview: boolean;
  suggestionReady: boolean;
  conflictSignals: boolean;
  manualChanges: boolean;
  needsReview: boolean;
  pendingPush: boolean;
  pushFailed: boolean;
  synced: boolean;
  primaryStatus: ShopifyCollectionMappingPrimaryStatus;
  statusLabel: "Needs Review" | "Ready to Push" | "Push Failed" | "Synced";
  statusBadgeTone: ShopifyCollectionMappingStatusBadgeTone;
};

export type ShopifyCollectionMappingKpiSummary = {
  totalLoaded: number;
  reviewNeeded: number;
  readyToPush: number;
  pushFailed: number;
  synced: number;
};

function ensureWorkflow(
  input: ShopifyCollectionMappingRowWorkflowInput | ShopifyCollectionMappingRowWorkflow
): ShopifyCollectionMappingRowWorkflow {
  if ("primaryStatus" in input) return input;
  return classifyShopifyCollectionMappingRow(input);
}

function normalizeMappingDecision(
  value: ShopifyCollectionMappingRowWorkflowInput["mappingDecision"]
): ShopifyCollectionMappingDecision {
  if (value === "AUTO_MAPPED" || value === "SUGGESTED" || value === "MANUAL_REVIEW") return value;
  return "MANUAL_REVIEW";
}

function normalizeCollectionSyncStatus(
  value: ShopifyCollectionMappingRowWorkflowInput["collectionSyncStatus"]
): ShopifyCollectionMappingSyncStatus {
  if (value === "ADD_PENDING" || value === "REMOVAL_PENDING" || value === "SYNCED" || value === "REVIEW") return value;
  return "REVIEW";
}

function normalizeActionStatus(value: ShopifyCollectionMappingRowWorkflowInput["actionStatus"]): ShopifyCollectionMappingActionStatus {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "FAILED") return "FAILED";
  if (normalized === "PROCESSED") return "PROCESSED";
  return "";
}

function normalizeCurrentMatchesFinal(
  value: ShopifyCollectionMappingRowWorkflowInput["currentMatchesFinal"],
  collectionSyncStatus: ShopifyCollectionMappingSyncStatus
): boolean {
  if (typeof value === "boolean") return value;
  return collectionSyncStatus === "SYNCED";
}

export function classifyShopifyCollectionMappingRow(
  input: ShopifyCollectionMappingRowWorkflowInput
): ShopifyCollectionMappingRowWorkflow {
  const mappingDecision = normalizeMappingDecision(input.mappingDecision);
  const collectionSyncStatus = normalizeCollectionSyncStatus(input.collectionSyncStatus);
  const actionStatus = normalizeActionStatus(input.actionStatus);
  const suggestionReady = Boolean(input.suggestionReady);
  const conflictSignals = Boolean(input.conflictSignals);
  const manualChanges = Boolean(input.manualChanges);
  const isReviewed = Boolean(input.isReviewed);
  const pushFailed = actionStatus === "FAILED";
  const currentMatchesFinal = normalizeCurrentMatchesFinal(input.currentMatchesFinal, collectionSyncStatus);
  const baseNeedsReview = mappingDecision === "MANUAL_REVIEW" || collectionSyncStatus === "REVIEW";
  const hasPendingCollectionWork =
    !currentMatchesFinal ||
    collectionSyncStatus === "REVIEW" ||
    collectionSyncStatus === "ADD_PENDING" ||
    collectionSyncStatus === "REMOVAL_PENDING";
  // Suggestions alone do not require human eye when live already matches final (informational chips).
  const requiresHumanEye =
    baseNeedsReview ||
    conflictSignals ||
    manualChanges ||
    (suggestionReady && hasPendingCollectionWork);
  const humanEyeResolved = !requiresHumanEye || isReviewed;
  const synced = !pushFailed && currentMatchesFinal && humanEyeResolved;
  const pendingPush = !pushFailed && !currentMatchesFinal && (requiresHumanEye ? isReviewed : true);
  const needsReview = !pushFailed && requiresHumanEye && !isReviewed;

  if (pushFailed) {
    return {
      mappingDecision,
      collectionSyncStatus,
      actionStatus,
      isReviewed,
      currentMatchesFinal,
      requiresHumanEye,
      baseNeedsReview,
      suggestionReady,
      conflictSignals,
      manualChanges,
      needsReview,
      pendingPush,
      pushFailed,
      synced,
      primaryStatus: "push-failed",
      statusLabel: "Push Failed",
      statusBadgeTone: "failed",
    };
  }

  if (synced) {
    return {
      mappingDecision,
      collectionSyncStatus,
      actionStatus,
      isReviewed,
      currentMatchesFinal,
      requiresHumanEye,
      baseNeedsReview,
      suggestionReady,
      conflictSignals,
      manualChanges,
      needsReview,
      pendingPush,
      pushFailed,
      synced,
      primaryStatus: "synced",
      statusLabel: "Synced",
      statusBadgeTone: "synced",
    };
  }

  if (pendingPush) {
    return {
      mappingDecision,
      collectionSyncStatus,
      actionStatus,
      isReviewed,
      currentMatchesFinal,
      requiresHumanEye,
      baseNeedsReview,
      suggestionReady,
      conflictSignals,
      manualChanges,
      needsReview,
      pendingPush,
      pushFailed,
      synced,
      primaryStatus: "ready-push",
      statusLabel: "Ready to Push",
      statusBadgeTone:
        collectionSyncStatus === "REMOVAL_PENDING"
          ? "removal-pending"
          : collectionSyncStatus === "ADD_PENDING"
            ? "add-pending"
            : "add-pending",
    };
  }

  return {
    mappingDecision,
    collectionSyncStatus,
    actionStatus,
    isReviewed,
    currentMatchesFinal,
    requiresHumanEye,
    baseNeedsReview,
    suggestionReady,
    conflictSignals,
    manualChanges,
    needsReview,
    pendingPush,
    pushFailed,
    synced,
    primaryStatus: "needs-review",
    statusLabel: "Needs Review",
    statusBadgeTone: "review",
  };
}

export function matchesShopifyCollectionMappingQueueTab(
  queueTab: ShopifyCollectionMappingQueueTab,
  workflow: ShopifyCollectionMappingRowWorkflow
): boolean {
  if (queueTab === "all") return true;
  if (queueTab === "needs-review" || queueTab === KPI_NEEDS_REVIEW_UNION_FILTER) return workflow.needsReview;
  if (queueTab === "suggestion-ready") return workflow.suggestionReady || workflow.conflictSignals;
  if (queueTab === "manual-changes") return workflow.manualChanges;
  if (queueTab === "ready-push") return workflow.pendingPush;
  if (queueTab === "push-failed") return workflow.pushFailed;
  if (queueTab === "synced") return workflow.synced;
  return true;
}

export function isNeedsReviewRow(
  input: ShopifyCollectionMappingRowWorkflowInput | ShopifyCollectionMappingRowWorkflow
): boolean {
  return ensureWorkflow(input).needsReview;
}

export function isPendingPushRow(
  input: ShopifyCollectionMappingRowWorkflowInput | ShopifyCollectionMappingRowWorkflow
): boolean {
  return ensureWorkflow(input).pendingPush;
}

export function isPushFailedRow(
  input: ShopifyCollectionMappingRowWorkflowInput | ShopifyCollectionMappingRowWorkflow
): boolean {
  return ensureWorkflow(input).pushFailed;
}

export function isSyncedRow(
  input: ShopifyCollectionMappingRowWorkflowInput | ShopifyCollectionMappingRowWorkflow
): boolean {
  return ensureWorkflow(input).synced;
}

export function summarizeShopifyCollectionMappingWorkflows(
  workflows: readonly ShopifyCollectionMappingRowWorkflow[]
): ShopifyCollectionMappingKpiSummary {
  let reviewNeeded = 0;
  let readyToPush = 0;
  let pushFailed = 0;
  let synced = 0;

  for (const workflow of workflows) {
    if (workflow.needsReview) reviewNeeded += 1;
    if (workflow.pendingPush) readyToPush += 1;
    if (workflow.pushFailed) pushFailed += 1;
    if (workflow.synced) synced += 1;
  }

  return {
    totalLoaded: workflows.length,
    reviewNeeded,
    readyToPush,
    pushFailed,
    synced,
  };
}
