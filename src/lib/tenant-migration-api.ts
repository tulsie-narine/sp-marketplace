import { supabase } from "@/integrations/supabase/client";

export interface MigrationClient {
  id: string;
  name: string;
  lifecycle: string;
  num_hardware_assets: number;
  client_id?: string | number;
  client_number?: string | number;
  key?: string;
  reference?: string;
  label?: string;
}

export interface DestinationUser {
  id: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  full_name?: string;
  email?: string;
  active?: boolean;
}

export type MigrationObjectType =
  | "initiatives"
  | "goals"
  | "notes"
  | "actionItems"
  | "contracts"
  | "assessments"
  | "meetings"
  | "deliverables"
  | "relationships";

export interface ClientMapping {
  srcClientId: string;
  srcClientName: string;
  dstClientId: string | null;
  dstClientName: string | null;
  skip: boolean;
}

export interface SelectedObjects {
  initiatives: boolean;
  goals: boolean;
  notes: boolean;
  actionItems: boolean;
  contracts: boolean;
  assessments: boolean;
  meetings: boolean;
  deliverables: boolean;
}

export type ProgressStatus = "pending" | "running" | "success" | "partial" | "failed" | "skipped";

export interface MigrationErrorEntry {
  clientName: string;
  objectType: string;
  recordName: string;
  errorCode: string;
  errorDetail: string;
}

export interface RelationshipLogEntry {
  clientName: string;
  type: string;
  sourceRecord: string;
  targetRecord: string;
  status: "created" | "failed" | "skipped";
  detail?: string;
}

export interface ObjectProgressState {
  type: MigrationObjectType;
  label: string;
  status: ProgressStatus;
  succeeded: number;
  total: number;
  errors: MigrationErrorEntry[];
}

export interface ClientMigrationProgress {
  clientId: string;
  clientName: string;
  destinationClientName: string;
  objects: Record<MigrationObjectType, ObjectProgressState>;
}

export interface ClientSummary {
  clientName: string;
  destinationClientName: string;
  counts: Record<Exclude<MigrationObjectType, "relationships">, { succeeded: number; total: number }>;
  status: "Complete" | "Partial" | "Failed";
}

export interface MigrationResult {
  clientSummaries: ClientSummary[];
  errors: MigrationErrorEntry[];
  relationshipLog: RelationshipLogEntry[];
  totalCreated: number;
  totalFailures: number;
}

export interface RunMigrationParams {
  sourceApiKey: string;
  destinationApiKey: string;
  mappings: ClientMapping[];
  selectedObjects: SelectedObjects;
  sourceClients: MigrationClient[];
  destinationClients: MigrationClient[];
  actionItemAssigneeId?: string | null;
  onClientProgress: (clientIndex: number, progress: ClientMigrationProgress) => void;
}

const OBJECT_ORDER: Exclude<MigrationObjectType, "relationships">[] = [
  "initiatives",
  "goals",
  "notes",
  "actionItems",
  "contracts",
  "assessments",
  "meetings",
  "deliverables",
];

export const OBJECT_LABELS: Record<MigrationObjectType, string> = {
  initiatives: "Initiatives",
  goals: "Goals",
  notes: "Notes",
  actionItems: "Action Items",
  contracts: "Contracts",
  assessments: "Assessments",
  meetings: "Meetings",
  deliverables: "Deliverables",
  relationships: "Relationships",
};

const DEFAULT_DELAY_MS = 120;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneProgress(progress: ClientMigrationProgress): ClientMigrationProgress {
  return {
    ...progress,
    objects: Object.fromEntries(
      Object.entries(progress.objects).map(([key, value]) => [key, { ...value, errors: [...value.errors] }])
    ) as ClientMigrationProgress["objects"],
  };
}

function buildInitialObjectState(type: MigrationObjectType): ObjectProgressState {
  return {
    type,
    label: OBJECT_LABELS[type],
    status: "pending",
    succeeded: 0,
    total: 0,
    errors: [],
  };
}

export function buildInitialClientProgress(mapping: ClientMapping): ClientMigrationProgress {
  return {
    clientId: mapping.srcClientId,
    clientName: mapping.srcClientName,
    destinationClientName: mapping.dstClientName || "Unmapped",
    objects: {
      initiatives: buildInitialObjectState("initiatives"),
      goals: buildInitialObjectState("goals"),
      notes: buildInitialObjectState("notes"),
      actionItems: buildInitialObjectState("actionItems"),
      contracts: buildInitialObjectState("contracts"),
      assessments: buildInitialObjectState("assessments"),
      meetings: buildInitialObjectState("meetings"),
      deliverables: buildInitialObjectState("deliverables"),
      relationships: buildInitialObjectState("relationships"),
    },
  };
}

function objectKey(type: string): string {
  return type === "actionItems" ? "action-items" : type;
}

function buildError(
  clientName: string,
  objectType: string,
  recordName: string,
  error: unknown
): MigrationErrorEntry {
  const detail = error instanceof Error ? error.message : "Unknown error";
  const statusMatch = detail.match(/\b(\d{3})\b/);
  return {
    clientName,
    objectType,
    recordName,
    errorCode: statusMatch?.[1] || "ERROR",
    errorDetail: detail,
  };
}

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

export function autoMatchClientMappings(
  sourceClients: MigrationClient[],
  destinationClients: MigrationClient[]
): ClientMapping[] {
  const exactMap = new Map(destinationClients.map((client) => [client.name.toLowerCase(), client]));
  const trimmedMap = new Map(destinationClients.map((client) => [normalizeName(client.name), client]));

  return sourceClients.map((sourceClient) => {
    const exact = exactMap.get(sourceClient.name.toLowerCase());
    const trimmed = trimmedMap.get(normalizeName(sourceClient.name));
    const match = exact || trimmed;

    return {
      srcClientId: sourceClient.id,
      srcClientName: sourceClient.name,
      dstClientId: match?.id || null,
      dstClientName: match?.name || null,
      skip: !match,
    };
  });
}

export function maskApiKey(value: string) {
  if (!value) return "Not connected";
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 7)}••••••${value.slice(-4)}`;
}

async function proxyCall<T = any>(
  apiKey: string,
  endpoint: string,
  method: string = "GET",
  body?: Record<string, unknown> | unknown[]
): Promise<T> {
  const { data, error } = await supabase.functions.invoke("scalepad-proxy", {
    body: { endpoint, method, body },
    headers: { "x-scalepad-api-key": apiKey },
  });

  if (error) {
    throw new Error(error.message || "Edge function error");
  }

  if (data?.upstream_status && data.upstream_status >= 400) {
    const detail = data.errors?.[0]?.detail || data.error || `API returned ${data.upstream_status}`;
    throw new Error(`${data.upstream_status}: ${detail}`);
  }

  if (data?.error) {
    throw new Error(data.error);
  }

  return data;
}

async function proxyCallWithRetry<T = any>(
  apiKey: string,
  endpoint: string,
  method: string = "GET",
  body?: Record<string, unknown> | unknown[]
): Promise<T> {
  try {
    return await proxyCall<T>(apiKey, endpoint, method, body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (!detail.startsWith("429")) {
      throw error;
    }

    const retryMatch = detail.match(/retry[- ]after[: ]+(\d+)/i);
    const retrySeconds = retryMatch ? Number(retryMatch[1]) : 1;
    await sleep(retrySeconds * 1000);
    return proxyCall<T>(apiKey, endpoint, method, body);
  }
}

async function fetchAllPages<T>(
  apiKey: string,
  endpointBuilder: (cursor: string | null) => string
): Promise<T[]> {
  const results: T[] = [];
  let cursor: string | null = null;

  do {
    const response = await proxyCallWithRetry<{ data?: T[]; next_cursor?: string | null }>(
      apiKey,
      endpointBuilder(cursor)
    );
    results.push(...(response.data || []));
    cursor = response.next_cursor || null;
  } while (cursor);

  return results;
}

export async function fetchAllClients(apiKey: string): Promise<MigrationClient[]> {
  return fetchAllPages<MigrationClient>(apiKey, (cursor) => {
    const params = new URLSearchParams({ page_size: "200", sort: "name" });
    if (cursor) params.set("cursor", cursor);
    return `/core/v1/clients?${params.toString()}`;
  });
}

export async function fetchAllDestinationUsers(apiKey: string): Promise<DestinationUser[]> {
  const members = await fetchAllPages<DestinationUser>(apiKey, (cursor) => {
    const params = new URLSearchParams({ page_size: "200", sort: "name" });
    if (cursor) params.set("cursor", cursor);
    return `/core/v1/members?${params.toString()}`;
  });

  return members.filter((member) => member.active !== false);
}

function omitFields(record: Record<string, unknown>, fields: string[]) {
  const clone = { ...record };
  for (const field of fields) {
    delete clone[field];
  }
  return clone;
}

function clientWriteBody(clientId: string, record: Record<string, unknown>, fieldsToOmit: string[] = []) {
  return {
    ...omitFields(record, [
      "id",
      "client",
      "client_id",
      "client_key",
      "record_created_at",
      "record_updated_at",
      "created_at",
      "updated_at",
      "archived_at",
      "deleted_at",
      "relationships",
      "attendees",
      "attendee_users",
      "attendee_contacts",
      ...fieldsToOmit,
    ]),
    client_key: { id: clientId },
  };
}

function getRecordName(record: Record<string, any>, fallback: string) {
  return (
    record.name ||
    record.title ||
    record.topic ||
    record.display_name ||
    record.label ||
    record.subject ||
    record.summary ||
    fallback
  );
}

export function getDestinationUserLabel(user: DestinationUser) {
  const fullName =
    user.name ||
    user.full_name ||
    [user.first_name, user.last_name].filter(Boolean).join(" ").trim();

  if (fullName && user.email) return `${fullName} (${user.email})`;
  return fullName || user.email || user.id;
}

function resolveClientRouteKey(client: MigrationClient | Record<string, any>) {
  return (
    client.client_id ||
    client.client_number ||
    client.key ||
    client.reference ||
    client.id
  );
}

function buildActionItemBody(
  destinationClientId: string,
  record: Record<string, any>,
  actionItemAssigneeId?: string | null
) {
  const body = clientWriteBody(destinationClientId, record, [
    "completion_status",
    "assigned_user_ids",
    "assigned_users",
    "assigned_user_id",
  ]);

  if (actionItemAssigneeId) {
    return {
      ...body,
      assigned_user_ids: [{ id: actionItemAssigneeId }],
    };
  }

  delete (body as Record<string, unknown>).assigned_user_ids;
  return body;
}

function buildContractCreatePayload(record: Record<string, any>) {
  const nestedPayload =
    record.create_payload && typeof record.create_payload === "object"
      ? { ...(record.create_payload as Record<string, unknown>) }
      : {};

  return {
    ...nestedPayload,
    name:
      nestedPayload.name ||
      record.name ||
      record.title ||
      "Untitled Contract",
    description:
      nestedPayload.description ||
      record.description ||
      record.summary ||
      "",
  };
}

function extractIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "id" in item && typeof item.id === "string") return item.id;
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

interface PendingRelationship {
  clientName: string;
  type: RelationshipLogEntry["type"];
  sourceRecord: string;
  targetRecord: string;
  sourceSourceId: string;
  targetSourceId: string;
}

function collectRelationships(type: Exclude<MigrationObjectType, "relationships">, record: Record<string, any>): PendingRelationship[] {
  const recordName = getRecordName(record, "Unnamed record");
  if (type === "goals") {
    return [
      ...extractIds(record.initiatives || record.linked_initiatives).map((targetId) => ({
        clientName: "",
        type: "Goal ↔ Initiative",
        sourceRecord: recordName,
        targetRecord: "Initiative",
        sourceSourceId: record.id,
        targetSourceId: targetId,
      })),
      ...extractIds(record.meetings || record.linked_meetings).map((targetId) => ({
        clientName: "",
        type: "Goal ↔ Meeting",
        sourceRecord: recordName,
        targetRecord: "Meeting",
        sourceSourceId: record.id,
        targetSourceId: targetId,
      })),
    ];
  }

  if (type === "initiatives") {
    return [
      ...extractIds(record.meetings || record.linked_meetings).map((targetId) => ({
        clientName: "",
        type: "Initiative ↔ Meeting",
        sourceRecord: recordName,
        targetRecord: "Meeting",
        sourceSourceId: record.id,
        targetSourceId: targetId,
      })),
      ...extractIds(record.action_items || record.actionItems || record.linked_action_items).map((targetId) => ({
        clientName: "",
        type: "Initiative ↔ Action Item",
        sourceRecord: recordName,
        targetRecord: "Action Item",
        sourceSourceId: record.id,
        targetSourceId: targetId,
      })),
    ];
  }

  if (type === "meetings") {
    return extractIds(record.action_items || record.actionItems || record.linked_action_items).map((targetId) => ({
      clientName: "",
      type: "Meeting ↔ Action Item",
      sourceRecord: recordName,
      targetRecord: "Action Item",
      sourceSourceId: record.id,
      targetSourceId: targetId,
    }));
  }

  return [];
}

async function fetchObjectRecords(
  apiKey: string,
  type: Exclude<MigrationObjectType, "relationships">,
  client: MigrationClient
): Promise<Record<string, any>[]> {
  if (type === "deliverables") {
    const clientRouteKey = resolveClientRouteKey(client);
    const deliverables = await fetchAllPages<Record<string, any>>(apiKey, (cursor) => {
      const params = new URLSearchParams({ page_size: "100" });
      if (cursor) params.set("cursor", cursor);
      return `/lifecycle-manager/v1/clients/${clientRouteKey}/deliverables?${params.toString()}`;
    });

    const detailed: Record<string, any>[] = [];
    for (const item of deliverables) {
      await sleep(DEFAULT_DELAY_MS);
      detailed.push(
        await proxyCallWithRetry<Record<string, any>>(apiKey, `/lifecycle-manager/v1/deliverables/${item.id}`)
      );
    }
    return detailed;
  }

  const endpointBase =
    type === "actionItems"
      ? "/lifecycle-manager/v1/action-items"
      : `/lifecycle-manager/v1/${objectKey(type)}`;

  const list = await fetchAllPages<Record<string, any>>(apiKey, (cursor) => {
    const params = new URLSearchParams({
      "filter[client.id]": client.id,
      page_size: "100",
    });
    if (cursor) params.set("cursor", cursor);
    return `${endpointBase}?${params.toString()}`;
  });

  if (type !== "assessments" && type !== "meetings") {
    return list;
  }

  const detailed: Record<string, any>[] = [];
  for (const item of list) {
    await sleep(DEFAULT_DELAY_MS);
    detailed.push(
      await proxyCallWithRetry<Record<string, any>>(apiKey, `${endpointBase}/${item.id}`)
    );
  }
  return detailed;
}

function getIdMaps() {
  return {
    initiatives: new Map<string, string>(),
    goals: new Map<string, string>(),
    actionItems: new Map<string, string>(),
    meetings: new Map<string, string>(),
  };
}

async function migrateRecord(
  type: Exclude<MigrationObjectType, "relationships">,
  destinationApiKey: string,
  destinationClient: MigrationClient,
  record: Record<string, any>,
  actionItemAssigneeId?: string | null
): Promise<{ newId?: string; recordName: string; relationships: PendingRelationship[] }> {
  const destinationClientId = destinationClient.id;
  const recordName = getRecordName(record, `Unnamed ${OBJECT_LABELS[type]}`);

  if (type === "initiatives") {
    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/initiatives",
      "POST",
      {
        client_key: { id: destinationClientId },
        name: record.name || record.title || "Untitled Initiative",
        executive_summary: record.executive_summary || "",
      }
    );
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(destinationApiKey, `/lifecycle-manager/v1/initiatives/${created.id}/status`, "PUT", {
      status: record.status || "New",
    });
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(destinationApiKey, `/lifecycle-manager/v1/initiatives/${created.id}/priority`, "PUT", {
      priority: record.priority || "None",
    });
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(destinationApiKey, `/lifecycle-manager/v1/initiatives/${created.id}/schedule`, "PUT", {
      fiscal_quarter: record.fiscal_quarter || null,
    });
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(destinationApiKey, `/lifecycle-manager/v1/initiatives/${created.id}/budget`, "PUT", {
      budget_line_items: record.budget?.line_items || [],
    });
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(destinationApiKey, `/lifecycle-manager/v1/initiatives/${created.id}/recurring`, "PUT", {
      recurring_line_items: record.budget?.recurring_line_items || [],
    });
    return {
      newId: created.id,
      recordName,
      relationships: collectRelationships(type, record),
    };
  }

  if (type === "goals") {
    const body = {
      client_key: { id: destinationClientId },
      title: record.title || "Untitled Goal",
      description: record.description || "",
      status: record.status || "OnTrack",
      target_period: record.target_period || record.period || null,
    };
    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/goals",
      "POST",
      body
    );
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(destinationApiKey, `/lifecycle-manager/v1/goals/${created.id}`, "PUT", body);
    return {
      newId: created.id,
      recordName,
      relationships: collectRelationships(type, record),
    };
  }

  if (type === "notes") {
    const body = clientWriteBody(destinationClientId, record);
    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/notes",
      "POST",
      body
    );
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(destinationApiKey, `/lifecycle-manager/v1/notes/${created.id}`, "PUT", body);
    return { newId: created.id, recordName, relationships: [] };
  }

  if (type === "actionItems") {
    const body = buildActionItemBody(destinationClientId, record, actionItemAssigneeId);
    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/action-items",
      "POST",
      body
    );
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(destinationApiKey, `/lifecycle-manager/v1/action-items/${created.id}`, "PUT", body);
    if (record.completion_status) {
      await sleep(DEFAULT_DELAY_MS);
      await proxyCallWithRetry(
        destinationApiKey,
        `/lifecycle-manager/v1/action-items/${created.id}/completion-status`,
        "PUT",
        { completion_status: record.completion_status }
      );
    }
    return {
      newId: created.id,
      recordName,
      relationships: collectRelationships(type, record),
    };
  }

  if (type === "contracts") {
    const body = {
      client_key: { id: destinationClientId },
      create_payload: buildContractCreatePayload(record),
    };
    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/contracts",
      "POST",
      body
    );
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(destinationApiKey, `/lifecycle-manager/v1/contracts/${created.id}`, "PUT", body);
    return { newId: created.id, recordName, relationships: [] };
  }

  if (type === "assessments") {
    const body = {
      ...clientWriteBody(destinationClientId, record, ["completion_status", "answered_items", "answers"]),
      evaluate_at: record.evaluate_at || record.record_updated_at || new Date().toISOString(),
    };
    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/assessments",
      "POST",
      body
    );
    if (record.completion_status) {
      await sleep(DEFAULT_DELAY_MS);
      await proxyCallWithRetry(
        destinationApiKey,
        `/lifecycle-manager/v1/assessments/${created.id}/completion-status`,
        "PUT",
        { completion_status: record.completion_status }
      );
    }
    const answers = record.answered_items || record.answers;
    if (answers) {
      await sleep(DEFAULT_DELAY_MS);
      await proxyCallWithRetry(
        destinationApiKey,
        `/lifecycle-manager/v1/assessments/${created.id}/evaluate`,
        "PUT",
        { answers }
      );
    }
    return { newId: created.id, recordName, relationships: [] };
  }

  if (type === "meetings") {
    const body = clientWriteBody(destinationClientId, record, [
      "completion_status",
      "attendees",
      "attendee_users",
      "attendee_contacts",
      "title",
    ]);
    const titledBody = {
      ...body,
      title: record.title || record.name || record.subject || record.topic || "Migrated Meeting",
    };
    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/meetings",
      "POST",
      titledBody
    );
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(destinationApiKey, `/lifecycle-manager/v1/meetings/${created.id}`, "PUT", titledBody);
    if (record.completion_status) {
      await sleep(DEFAULT_DELAY_MS);
      await proxyCallWithRetry(
        destinationApiKey,
        `/lifecycle-manager/v1/meetings/${created.id}/completion-status`,
        "PUT",
        { completion_status: record.completion_status }
      );
    }

    const userIds = extractIds(record.attendees?.users || record.attendee_users || record.users);
    if (userIds.length > 0) {
      await sleep(DEFAULT_DELAY_MS);
      await proxyCallWithRetry(
        destinationApiKey,
        `/lifecycle-manager/v1/meetings/${created.id}/attendees/users`,
        "POST",
        { user_ids: userIds }
      );
    }

    const contactIds = extractIds(record.attendees?.contacts || record.attendee_contacts || record.contacts);
    if (contactIds.length > 0) {
      await sleep(DEFAULT_DELAY_MS);
      await proxyCallWithRetry(
        destinationApiKey,
        `/lifecycle-manager/v1/meetings/${created.id}/attendees/contacts`,
        "POST",
        { contact_ids: contactIds }
      );
    }
    return {
      newId: created.id,
      recordName,
      relationships: collectRelationships(type, record),
    };
  }

  const body = omitFields(record, ["id", "client", "client_id", "client_key", "record_created_at", "record_updated_at"]);
  const created = await proxyCallWithRetry<{ id: string }>(
    destinationApiKey,
    `/lifecycle-manager/v1/clients/${resolveClientRouteKey(destinationClient)}/deliverables`,
    "POST",
    body
  );
  await sleep(DEFAULT_DELAY_MS);
  await proxyCallWithRetry(destinationApiKey, `/lifecycle-manager/v1/deliverables/${created.id}`, "PATCH", body);
  return { newId: created.id, recordName, relationships: [] };
}

async function createRelationships(
  destinationApiKey: string,
  clientName: string,
  pendingRelationships: PendingRelationship[],
  idMaps: ReturnType<typeof getIdMaps>
): Promise<RelationshipLogEntry[]> {
  const log: RelationshipLogEntry[] = [];

  for (const item of pendingRelationships) {
    await sleep(DEFAULT_DELAY_MS);
    try {
      let endpoint: string | null = null;

      if (item.type === "Goal ↔ Initiative") {
        const goalId = idMaps.goals.get(item.sourceSourceId);
        const initiativeId = idMaps.initiatives.get(item.targetSourceId);
        endpoint = goalId && initiativeId ? `/lifecycle-manager/v1/goals/${goalId}/initiatives/${initiativeId}` : null;
      } else if (item.type === "Goal ↔ Meeting") {
        const goalId = idMaps.goals.get(item.sourceSourceId);
        const meetingId = idMaps.meetings.get(item.targetSourceId);
        endpoint = goalId && meetingId ? `/lifecycle-manager/v1/goals/${goalId}/meetings/${meetingId}` : null;
      } else if (item.type === "Initiative ↔ Meeting") {
        const initiativeId = idMaps.initiatives.get(item.sourceSourceId);
        const meetingId = idMaps.meetings.get(item.targetSourceId);
        endpoint = initiativeId && meetingId ? `/lifecycle-manager/v1/initiatives/${initiativeId}/meetings/${meetingId}` : null;
      } else if (item.type === "Initiative ↔ Action Item") {
        const initiativeId = idMaps.initiatives.get(item.sourceSourceId);
        const actionItemId = idMaps.actionItems.get(item.targetSourceId);
        endpoint = initiativeId && actionItemId ? `/lifecycle-manager/v1/initiatives/${initiativeId}/action-items/${actionItemId}` : null;
      } else if (item.type === "Meeting ↔ Action Item") {
        const meetingId = idMaps.meetings.get(item.sourceSourceId);
        const actionItemId = idMaps.actionItems.get(item.targetSourceId);
        endpoint = meetingId && actionItemId ? `/lifecycle-manager/v1/meetings/${meetingId}/action-items/${actionItemId}` : null;
      }

      if (!endpoint) {
        log.push({
          clientName,
          type: item.type,
          sourceRecord: item.sourceRecord,
          targetRecord: item.targetRecord,
          status: "skipped",
          detail: "Source record did not migrate",
        });
        continue;
      }

      await proxyCallWithRetry(destinationApiKey, endpoint, "PUT");
      log.push({
        clientName,
        type: item.type,
        sourceRecord: item.sourceRecord,
        targetRecord: item.targetRecord,
        status: "created",
      });
    } catch (error) {
      log.push({
        clientName,
        type: item.type,
        sourceRecord: item.sourceRecord,
        targetRecord: item.targetRecord,
        status: "failed",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return log;
}

export async function runTenantMigration({
  sourceApiKey,
  destinationApiKey,
  mappings,
  selectedObjects,
  sourceClients,
  destinationClients,
  actionItemAssigneeId,
  onClientProgress,
}: RunMigrationParams): Promise<MigrationResult> {
  const clientSummaries: ClientSummary[] = [];
  const allErrors: MigrationErrorEntry[] = [];
  const relationshipLog: RelationshipLogEntry[] = [];
  let totalCreated = 0;
  let totalFailures = 0;
  const sourceClientLookup = new Map(sourceClients.map((client) => [client.id, client]));
  const destinationClientLookup = new Map(destinationClients.map((client) => [client.id, client]));

  for (let clientIndex = 0; clientIndex < mappings.length; clientIndex += 1) {
    const mapping = mappings[clientIndex];
    if (mapping.skip || !mapping.dstClientId || !mapping.dstClientName) {
      continue;
    }

    const progress = buildInitialClientProgress(mapping);
    onClientProgress(clientIndex, cloneProgress(progress));

    const idMaps = getIdMaps();
    const pendingRelationships: PendingRelationship[] = [];
    const sourceClient = sourceClientLookup.get(mapping.srcClientId);
    const destinationClient = destinationClientLookup.get(mapping.dstClientId);

    if (!sourceClient || !destinationClient) {
      continue;
    }

    for (const type of OBJECT_ORDER) {
      const selected = selectedObjects[type];
      if (!selected) {
        progress.objects[type].status = "skipped";
        onClientProgress(clientIndex, cloneProgress(progress));
        continue;
      }

      progress.objects[type].status = "running";
      onClientProgress(clientIndex, cloneProgress(progress));

      let records: Record<string, any>[] = [];
      try {
        records = await fetchObjectRecords(sourceApiKey, type, sourceClient);
        progress.objects[type].total = records.length;
        onClientProgress(clientIndex, cloneProgress(progress));
      } catch (error) {
        const entry = buildError(mapping.srcClientName, OBJECT_LABELS[type], "Fetch failed", error);
        progress.objects[type].status = "failed";
        progress.objects[type].errors.push(entry);
        allErrors.push(entry);
        totalFailures += 1;
        onClientProgress(clientIndex, cloneProgress(progress));
        continue;
      }

      if (records.length === 0) {
        progress.objects[type].status = "success";
        onClientProgress(clientIndex, cloneProgress(progress));
        continue;
      }

      for (const record of records) {
        await sleep(DEFAULT_DELAY_MS);
        try {
          const result = await migrateRecord(
            type,
            destinationApiKey,
            destinationClient,
            record,
            actionItemAssigneeId
          );
          progress.objects[type].succeeded += 1;
          totalCreated += 1;

          if (type === "initiatives" && result.newId) idMaps.initiatives.set(record.id, result.newId);
          if (type === "goals" && result.newId) idMaps.goals.set(record.id, result.newId);
          if (type === "actionItems" && result.newId) idMaps.actionItems.set(record.id, result.newId);
          if (type === "meetings" && result.newId) idMaps.meetings.set(record.id, result.newId);

          pendingRelationships.push(
            ...result.relationships.map((item) => ({ ...item, clientName: mapping.srcClientName }))
          );
        } catch (error) {
          const entry = buildError(mapping.srcClientName, OBJECT_LABELS[type], getRecordName(record, "Unnamed record"), error);
          progress.objects[type].errors.push(entry);
          allErrors.push(entry);
          totalFailures += 1;
        }

        progress.objects[type].status =
          progress.objects[type].errors.length > 0 ? "partial" : "running";
        onClientProgress(clientIndex, cloneProgress(progress));
      }

      if (progress.objects[type].errors.length === 0) {
        progress.objects[type].status = "success";
      } else if (progress.objects[type].succeeded === 0) {
        progress.objects[type].status = "failed";
      } else {
        progress.objects[type].status = "partial";
      }
      onClientProgress(clientIndex, cloneProgress(progress));
    }

    progress.objects.relationships.status = "running";
    progress.objects.relationships.total = pendingRelationships.length;
    onClientProgress(clientIndex, cloneProgress(progress));

    const clientRelationshipLog = await createRelationships(
      destinationApiKey,
      mapping.srcClientName,
      pendingRelationships,
      idMaps
    );
    relationshipLog.push(...clientRelationshipLog);
    progress.objects.relationships.succeeded = clientRelationshipLog.filter((entry) => entry.status === "created").length;
    const relationshipFailures = clientRelationshipLog.filter((entry) => entry.status !== "created").length;
    progress.objects.relationships.status =
      relationshipFailures === 0 ? "success" : progress.objects.relationships.succeeded > 0 ? "partial" : "failed";
    progress.objects.relationships.errors = clientRelationshipLog
      .filter((entry) => entry.status === "failed")
      .map((entry) => ({
        clientName: entry.clientName,
        objectType: "Relationships",
        recordName: `${entry.sourceRecord} -> ${entry.targetRecord}`,
        errorCode: "RELATIONSHIP",
        errorDetail: entry.detail || "Relationship failed",
      }));
    onClientProgress(clientIndex, cloneProgress(progress));

    const counts = {
      initiatives: {
        succeeded: progress.objects.initiatives.succeeded,
        total: progress.objects.initiatives.total,
      },
      goals: {
        succeeded: progress.objects.goals.succeeded,
        total: progress.objects.goals.total,
      },
      notes: {
        succeeded: progress.objects.notes.succeeded,
        total: progress.objects.notes.total,
      },
      actionItems: {
        succeeded: progress.objects.actionItems.succeeded,
        total: progress.objects.actionItems.total,
      },
      contracts: {
        succeeded: progress.objects.contracts.succeeded,
        total: progress.objects.contracts.total,
      },
      assessments: {
        succeeded: progress.objects.assessments.succeeded,
        total: progress.objects.assessments.total,
      },
      meetings: {
        succeeded: progress.objects.meetings.succeeded,
        total: progress.objects.meetings.total,
      },
      deliverables: {
        succeeded: progress.objects.deliverables.succeeded,
        total: progress.objects.deliverables.total,
      },
    };

    const objectFailures = OBJECT_ORDER.reduce((sum, type) => sum + progress.objects[type].errors.length, 0);
    const totalRecords = OBJECT_ORDER.reduce((sum, type) => sum + progress.objects[type].total, 0);

    clientSummaries.push({
      clientName: mapping.srcClientName,
      destinationClientName: mapping.dstClientName,
      counts,
      status: objectFailures === 0 ? "Complete" : totalRecords === objectFailures ? "Failed" : "Partial",
    });
  }

  return {
    clientSummaries,
    errors: allErrors,
    relationshipLog,
    totalCreated,
    totalFailures,
  };
}
