import {
  OBJECT_LABELS,
  buildInitialClientProgress,
  fetchAllClients as fetchTenantClients,
  runTenantMigration,
  type ClientMapping,
  type ClientMigrationProgress,
  type ClientSummary,
  type MigrationClient,
  type MigrationErrorEntry,
  type ProgressStatus,
  type RelationshipLogEntry,
  type SelectedObjects,
} from "@/lib/tenant-migration-api";
import {
  getSectionConfigs,
  runClientCleanup,
  type CleanupClient,
  type CleanupError,
  type ClientProgress,
  type SectionType,
} from "@/lib/cleanup-api";

export type ResetStage = "pending" | "reset" | "migrate" | "complete";

export interface LcmDataResetClientProgress {
  targetClientId: string;
  targetClientName: string;
  sourceClientName: string;
  stage: ResetStage;
  status: ProgressStatus;
  note?: string;
  reset: ClientProgress;
  migration: ClientMigrationProgress;
}

export interface LcmDataResetClientSummary {
  targetClientId: string;
  targetClientName: string;
  sourceClientName: string;
  resetDeleted: number;
  resetStatus: ProgressStatus;
  migrationCreated: number;
  migrationStatus: ClientSummary["status"] | "Skipped";
  status: "Complete" | "Partial" | "Failed";
  note?: string;
}

export interface LcmDataResetResult {
  clientSummaries: LcmDataResetClientSummary[];
  errors: MigrationErrorEntry[];
  relationshipLog: RelationshipLogEntry[];
  totalDeleted: number;
  totalCreated: number;
  totalFailures: number;
}

export interface RunLcmDataResetParams {
  sourceApiKey: string;
  destinationApiKey: string;
  sourceClient: MigrationClient;
  destinationClients: MigrationClient[];
  selectedObjects: SelectedObjects;
  actionItemAssigneeEmail?: string | null;
  onClientProgress: (
    clientIndex: number,
    progress: LcmDataResetClientProgress
  ) => void;
}

export async function fetchAllClients(apiKey: string): Promise<MigrationClient[]> {
  return fetchTenantClients(apiKey);
}

export const RESET_OBJECT_OPTIONS: {
  key: keyof SelectedObjects;
  label: string;
}[] = [
  { key: "initiatives", label: "Initiatives / Roadmap" },
  { key: "goals", label: "Goals" },
  { key: "meetings", label: "Meetings" },
  { key: "notes", label: "Notes" },
  { key: "actionItems", label: "Action Items" },
  { key: "contracts", label: "Contracts" },
  { key: "assessments", label: "Assessments" },
  { key: "deliverables", label: "Deliverables" },
];

export const DEFAULT_RESET_SELECTED_OBJECTS: SelectedObjects = {
  initiatives: true,
  goals: true,
  notes: true,
  actionItems: true,
  contracts: true,
  assessments: true,
  meetings: true,
  deliverables: true,
  tags: false,
};

function toCleanupClient(client: MigrationClient): CleanupClient {
  return {
    id: client.id,
    name: client.name,
    lifecycle: client.lifecycle || "—",
    num_hardware_assets: client.num_hardware_assets ?? 0,
  };
}

function selectedObjectsToCleanupSections(
  selectedObjects: SelectedObjects
): Record<SectionType, boolean> {
  return {
    initiatives: selectedObjects.initiatives,
    goals: selectedObjects.goals,
    meetings: selectedObjects.meetings,
    actionItems: selectedObjects.actionItems,
    notes: selectedObjects.notes,
    assessments: selectedObjects.assessments,
    contracts: selectedObjects.contracts,
    deliverables: selectedObjects.deliverables,
  };
}

function cloneResetProgress(progress: LcmDataResetClientProgress): LcmDataResetClientProgress {
  return {
    ...progress,
    reset: {
      ...progress.reset,
      sections: progress.reset.sections.map((section) => ({ ...section })),
    },
    migration: {
      ...progress.migration,
      objects: Object.fromEntries(
        Object.entries(progress.migration.objects).map(([key, value]) => [
          key,
          { ...value, errors: [...value.errors] },
        ])
      ) as ClientMigrationProgress["objects"],
    },
  };
}

function buildInitialResetProgress(
  sourceClient: MigrationClient,
  destinationClient: MigrationClient,
  selectedObjects: SelectedObjects
): LcmDataResetClientProgress {
  const cleanupSelection = selectedObjectsToCleanupSections(selectedObjects);
  const mapping: ClientMapping = {
    srcClientId: sourceClient.id,
    srcClientName: sourceClient.name,
    dstClientId: destinationClient.id,
    dstClientName: destinationClient.name,
    skip: false,
  };

  return {
    targetClientId: destinationClient.id,
    targetClientName: destinationClient.name,
    sourceClientName: sourceClient.name,
    stage: "pending",
    status: "pending",
    reset: {
      clientId: destinationClient.id,
      clientName: destinationClient.name,
      sections: getSectionConfigs().map((section) => ({
        type: section.type,
        label: section.label,
        status: cleanupSelection[section.type] ? "pending" : "skipped",
        deleted: 0,
        total: 0,
      })),
    },
    migration: buildInitialClientProgress(mapping),
  };
}

function mapCleanupError(error: CleanupError): MigrationErrorEntry {
  return {
    clientName: error.clientName,
    objectType: error.section,
    recordName: error.recordId,
    errorCode: error.errorCode,
    errorDetail: error.errorDetail,
    severity: "error",
  };
}

function countDeleted(progress: ClientProgress) {
  return progress.sections.reduce((total, section) => total + section.deleted, 0);
}

function resetHasBlockingFailures(progress: ClientProgress, selectedObjects: SelectedObjects) {
  const cleanupSelection = selectedObjectsToCleanupSections(selectedObjects);
  return progress.sections.some((section) => {
    if (!cleanupSelection[section.type]) return false;
    return section.status === "failed" || section.status === "partial";
  });
}

function markMigrationSkipped(progress: LcmDataResetClientProgress) {
  for (const [type, objectProgress] of Object.entries(progress.migration.objects)) {
    if (type === "relationships") {
      objectProgress.status = "skipped";
      continue;
    }
    if (objectProgress.status === "pending") {
      objectProgress.status = "skipped";
    }
  }
}

function summarizeClientRun(
  progress: LcmDataResetClientProgress,
  migrationCreated: number
): LcmDataResetClientSummary {
  const resetDeleted = countDeleted(progress.reset);
  const migrationHasBlockingErrors = Object.entries(progress.migration.objects)
    .filter(([type]) => type !== "relationships")
    .some(([, objectProgress]) =>
      objectProgress.errors.some((entry) => entry.severity !== "warning")
    );

  const resetStatus = progress.reset.sections.some((section) => section.status === "failed")
    ? "failed"
    : progress.reset.sections.some((section) => section.status === "partial")
    ? "partial"
    : "success";

  const migrationStatus: LcmDataResetClientSummary["migrationStatus"] =
    progress.note?.includes("skipped")
      ? "Skipped"
      : migrationHasBlockingErrors
      ? migrationCreated > 0
        ? "Partial"
        : "Failed"
      : "Complete";

  const overallStatus: LcmDataResetClientSummary["status"] =
    resetStatus === "success" && migrationStatus === "Complete"
      ? "Complete"
      : resetDeleted > 0 || migrationCreated > 0
      ? "Partial"
      : "Failed";

  return {
    targetClientId: progress.targetClientId,
    targetClientName: progress.targetClientName,
    sourceClientName: progress.sourceClientName,
    resetDeleted,
    resetStatus,
    migrationCreated,
    migrationStatus,
    status: overallStatus,
    note: progress.note,
  };
}

export async function runLcmDataReset({
  sourceApiKey,
  destinationApiKey,
  sourceClient,
  destinationClients,
  selectedObjects,
  actionItemAssigneeEmail,
  onClientProgress,
}: RunLcmDataResetParams): Promise<LcmDataResetResult> {
  const clientSummaries: LcmDataResetClientSummary[] = [];
  const errors: MigrationErrorEntry[] = [];
  const relationshipLog: RelationshipLogEntry[] = [];
  let totalDeleted = 0;
  let totalCreated = 0;
  let totalFailures = 0;

  for (let clientIndex = 0; clientIndex < destinationClients.length; clientIndex += 1) {
    const destinationClient = destinationClients[clientIndex];
    const progress = buildInitialResetProgress(
      sourceClient,
      destinationClient,
      selectedObjects
    );
    progress.stage = "reset";
    progress.status = "running";
    onClientProgress(clientIndex, cloneResetProgress(progress));

    const cleanupSelection = selectedObjectsToCleanupSections(selectedObjects);
    const cleanupProgress = await runClientCleanup(
      destinationApiKey,
      toCleanupClient(destinationClient),
      cleanupSelection,
      (nextProgress) => {
        progress.stage = "reset";
        progress.reset = nextProgress;
        onClientProgress(clientIndex, cloneResetProgress(progress));
      },
      (cleanupError) => {
        errors.push(mapCleanupError(cleanupError));
        totalFailures += 1;
      }
    );

    progress.reset = cleanupProgress;
    totalDeleted += countDeleted(cleanupProgress);

    if (resetHasBlockingFailures(cleanupProgress, selectedObjects)) {
      progress.stage = "complete";
      progress.status = cleanupProgress.sections.some((section) => section.status === "failed")
        ? "failed"
        : "partial";
      progress.note =
        "Migration skipped because the reset phase did not fully clear this destination client.";
      markMigrationSkipped(progress);
      onClientProgress(clientIndex, cloneResetProgress(progress));
      clientSummaries.push(summarizeClientRun(progress, 0));
      continue;
    }

    progress.stage = "migrate";
    progress.status = "running";
    onClientProgress(clientIndex, cloneResetProgress(progress));

    const mapping: ClientMapping = {
      srcClientId: sourceClient.id,
      srcClientName: sourceClient.name,
      dstClientId: destinationClient.id,
      dstClientName: destinationClient.name,
      skip: false,
    };

    const migrationResult = await runTenantMigration({
      sourceApiKey,
      destinationApiKey,
      mappings: [mapping],
      selectedObjects,
      sourceClients: [sourceClient],
      destinationClients: [destinationClient],
      onClientProgress: (_innerIndex, migrationProgress) => {
        progress.stage = "migrate";
        progress.migration = migrationProgress;
        onClientProgress(clientIndex, cloneResetProgress(progress));
      },
    });

    totalCreated += migrationResult.totalCreated;
    totalFailures += migrationResult.totalFailures;
    errors.push(...migrationResult.errors);
    relationshipLog.push(...migrationResult.relationshipLog);

    const migrationSummary = migrationResult.clientSummaries[0];
    progress.stage = "complete";
    progress.status =
      migrationSummary?.status === "Complete"
        ? "success"
        : migrationSummary?.status === "Partial"
        ? "partial"
        : "failed";
    onClientProgress(clientIndex, cloneResetProgress(progress));

    clientSummaries.push(
      summarizeClientRun(progress, migrationResult.totalCreated)
    );
  }

  return {
    clientSummaries,
    errors,
    relationshipLog,
    totalDeleted,
    totalCreated,
    totalFailures,
  };
}
