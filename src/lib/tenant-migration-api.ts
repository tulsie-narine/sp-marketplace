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
  short_id?: string;
  code?: string;
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

export type ProgressStatus =
  | "pending"
  | "running"
  | "success"
  | "partial"
  | "failed"
  | "skipped";

export interface MigrationErrorEntry {
  clientName: string;
  objectType: string;
  recordName: string;
  errorCode: string;
  errorDetail: string;
  severity?: "error" | "warning";
  endpoint?: string;
  method?: string;
  requestPayload?: Record<string, unknown> | unknown[] | null;
  requestPayloadText?: string;
  resolvedEmail?: string | null;
  resolvedUserId?: string | null;
  sourceUserId?: string | null;
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
  counts: Record<
    Exclude<MigrationObjectType, "relationships">,
    { succeeded: number; total: number }
  >;
  status: "Complete" | "Partial" | "Failed";
}

export interface MigrationResult {
  clientSummaries: ClientSummary[];
  errors: MigrationErrorEntry[];
  relationshipLog: RelationshipLogEntry[];
  totalCreated: number;
  totalFailures: number;
  debugDiagnostics?: MigrationDebugEntry[];
}

export interface RunMigrationParams {
  sourceApiKey: string;
  destinationApiKey: string;
  mappings: ClientMapping[];
  selectedObjects: SelectedObjects;
  sourceClients: MigrationClient[];
  destinationClients: MigrationClient[];
  actionItemAssigneeEmail?: string | null;
  onClientProgress: (
    clientIndex: number,
    progress: ClientMigrationProgress
  ) => void;
}

type ApiBody = Record<string, unknown> | unknown[];

interface DestinationMember {
  id: string;
  email: string;
}

interface DestinationMeetingType {
  id: string;
  label: string;
}

interface AssessmentTemplateOverview {
  id: string;
  title: string;
}

interface PendingRelationship {
  clientName: string;
  type: RelationshipLogEntry["type"];
  sourceRecord: string;
  targetRecord: string;
  sourceSourceId: string;
  targetSourceId: string;
}

export interface MigrationDebugEntry {
  clientName: string;
  objectType: string;
  recordName: string;
  resolvedEmail?: string | null;
  resolvedUserId?: string | null;
  sourceUserId?: string | null;
  note?: string | null;
}

const DEFAULT_DELAY_MS = 120;
const OBJECT_ORDER: Exclude<MigrationObjectType, "relationships">[] = [
  "initiatives",
  "goals",
  "meetings",
  "notes",
  "actionItems",
  "contracts",
  "assessments",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function asText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number") return String(value);
  if (isRecord(value)) {
    return (
      asText(value.value) ||
      asText(value.label) ||
      asText(value.name) ||
      asText(value.full_name) ||
      asText(value.email) ||
      null
    );
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneProgress(
  progress: ClientMigrationProgress
): ClientMigrationProgress {
  return {
    ...progress,
    objects: Object.fromEntries(
      Object.entries(progress.objects).map(([key, value]) => [
        key,
        { ...value, errors: [...value.errors] },
      ])
    ) as ClientMigrationProgress["objects"],
  };
}

function buildInitialObjectState(
  type: MigrationObjectType
): ObjectProgressState {
  return {
    type,
    label: OBJECT_LABELS[type],
    status: "pending",
    succeeded: 0,
    total: 0,
    errors: [],
  };
}

export function buildInitialClientProgress(
  mapping: ClientMapping
): ClientMigrationProgress {
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

function buildFullApiUrl(endpoint: string) {
  return `https://api.scalepad.com${endpoint}`;
}

function stringifyRequestPayload(body?: ApiBody) {
  if (body === undefined) return null;
  try {
    return JSON.stringify(body);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function buildApiError(
  message: string,
  endpoint: string,
  method: string,
  body?: ApiBody
) {
  const error = new Error(message) as Error & {
    endpoint?: string;
    method?: string;
    requestPayload?: ApiBody | null;
    requestPayloadText?: string | null;
  };
  error.endpoint = buildFullApiUrl(endpoint);
  error.method = method;
  error.requestPayload = body ?? null;
  error.requestPayloadText = stringifyRequestPayload(body);
  return error;
}

function buildError(
  clientName: string,
  objectType: string,
  recordName: string,
  error: unknown
): MigrationErrorEntry {
  const detail = error instanceof Error ? error.message : "Unknown error";
  const apiError = isRecord(error) ? error : null;
  const match = detail.match(/\b(\d{3})\b/);
  return {
    clientName,
    objectType,
    recordName,
    errorCode: match?.[1] || "ERROR",
    errorDetail: detail,
    severity: "error",
    endpoint: asText(apiError?.endpoint) || undefined,
    method: asText(apiError?.method) || undefined,
    requestPayload:
      apiError && "requestPayload" in apiError
        ? ((apiError.requestPayload as ApiBody | null | undefined) ?? null)
        : undefined,
    requestPayloadText: asText(apiError?.requestPayloadText) || undefined,
    resolvedEmail: asText(apiError?.resolvedEmail) || undefined,
    resolvedUserId: asText(apiError?.resolvedUserId) || undefined,
    sourceUserId: asText(apiError?.sourceUserId) || undefined,
  };
}

function buildWarning(
  clientName: string,
  objectType: string,
  recordName: string,
  detail: string
): MigrationErrorEntry {
  return {
    clientName,
    objectType,
    recordName,
    errorCode: "WARN",
    errorDetail: detail,
    severity: "warning",
  };
}

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

export function autoMatchClientMappings(
  sourceClients: MigrationClient[],
  destinationClients: MigrationClient[]
): ClientMapping[] {
  const exact = new Map(
    destinationClients.map((client) => [client.name.toLowerCase(), client])
  );
  const trimmed = new Map(
    destinationClients.map((client) => [normalizeName(client.name), client])
  );

  return sourceClients.map((sourceClient) => {
    const match =
      exact.get(sourceClient.name.toLowerCase()) ||
      trimmed.get(normalizeName(sourceClient.name));

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
  if (value.length <= 8) return "........";
  return `${value.slice(0, 7)}......${value.slice(-4)}`;
}

async function proxyCall<T = any>(
  apiKey: string,
  endpoint: string,
  method = "GET",
  body?: ApiBody
): Promise<T> {
  const { data, error } = await supabase.functions.invoke("scalepad-proxy", {
    body: { endpoint, method, body },
    headers: { "x-scalepad-api-key": apiKey },
  });

  if (error) {
    throw buildApiError(
      error.message || "Edge function error",
      endpoint,
      method,
      body
    );
  }

  if (data?.upstream_status && data.upstream_status >= 400) {
    const detail =
      data.errors?.[0]?.detail ||
      data.error ||
      `API returned ${data.upstream_status}`;
    throw buildApiError(
      `${data.upstream_status}: ${detail}`,
      endpoint,
      method,
      body
    );
  }

  if (data?.error) {
    throw buildApiError(data.error, endpoint, method, body);
  }

  return data;
}

async function proxyCallWithRetry<T = any>(
  apiKey: string,
  endpoint: string,
  method = "GET",
  body?: ApiBody
): Promise<T> {
  try {
    return await proxyCall<T>(apiKey, endpoint, method, body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (!detail.startsWith("429")) throw error;
    const retryMatch = detail.match(/retry[- ]after[: ]+(\d+)/i);
    const retrySeconds = retryMatch ? Number(retryMatch[1]) : 1;
    await sleep(retrySeconds * 1000);
    return proxyCall<T>(apiKey, endpoint, method, body);
  }
}

async function fetchAllPages<T>(
  apiKey: string,
  buildEndpoint: (cursor: string | null) => string
): Promise<T[]> {
  const results: T[] = [];
  let cursor: string | null = null;

  do {
    const response = await proxyCallWithRetry<{
      data?: T[];
      next_cursor?: string | null;
    }>(apiKey, buildEndpoint(cursor));
    results.push(...(response.data || []));
    cursor = response.next_cursor || null;
  } while (cursor);

  return results;
}

export async function fetchAllClients(
  apiKey: string
): Promise<MigrationClient[]> {
  const clients = await fetchAllPages<MigrationClient>(apiKey, (cursor) => {
    const params = new URLSearchParams({
      page_size: "200",
      sort: "name",
    });
    if (cursor) params.set("cursor", cursor);
    return `/core/v1/clients?${params.toString()}`;
  });

  return clients.filter(
    (client): client is MigrationClient =>
      isRecord(client) &&
      typeof client.id === "string" &&
      typeof client.name === "string"
  );
}

function getRecordName(record: Record<string, any>, fallback: string) {
  return (
    record.name ||
    record.title ||
    record.description ||
    record.topic ||
    record.display_name ||
    record.label ||
    record.subject ||
    record.summary ||
    fallback
  );
}

function extractIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === "string") return item;
      if (isRecord(item) && typeof item.id === "string") return item.id;
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

function extractFirstEmail(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const email =
      asText(item.email) ||
      asText(item.contact_info?.email) ||
      asText(item.user?.email) ||
      asText(item.member?.email);
    if (email) return email;
  }
  return null;
}

function extractActionItemAssigneeEmail(record: Record<string, any>) {
  return (
    asText(record.assigned_user?.email) ||
    asText(record.assigned_user_email) ||
    asText(record.assignee?.email) ||
    asText(record.assignee_email) ||
    extractFirstEmail(record.assigned_user_ids) ||
    extractFirstEmail(record.assigned_users) ||
    extractFirstEmail(record.assignees) ||
    null
  );
}

function extractAssessmentEvaluatorEmail(record: Record<string, any>) {
  return (
    asText(record.evaluate_user?.contact_info?.email) ||
    asText(record.evaluate_user?.email) ||
    asText(record.evaluator?.contact_info?.email) ||
    asText(record.evaluator?.email) ||
    asText(record.evaluate_user_email) ||
    asText(record.evaluator_email) ||
    null
  );
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function normalizeDueAt(value: unknown): string | null {
  return isIsoDateTime(value) ? value : null;
}

function normalizeMeetingTypeLabel(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  return text.replace(/[\s\-_]+/g, "").toLowerCase();
}

function resolveMeetingTypeId(
  record: Record<string, any>,
  destinationMeetingTypes: DestinationMeetingType[]
): string | null {
  const normalizedSourceLabel =
    normalizeMeetingTypeLabel(record.meeting_type?.label) ||
    normalizeMeetingTypeLabel(record.type) ||
    normalizeMeetingTypeLabel(record.meeting_type?.type);

  if (!normalizedSourceLabel) return null;

  return (
    destinationMeetingTypes.find(
      (meetingType) =>
        normalizeMeetingTypeLabel(meetingType.label) === normalizedSourceLabel
    )?.id || null
  );
}

function buildProseMirrorJson(text: string) {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  });
}

function buildContractCreatePayload(record: Record<string, any>) {
  const nested = isRecord(record.create_payload)
    ? { ...record.create_payload }
    : {};
  const resolvedBillingStartAt =
    asText(nested.billing_start_at) ||
    asText(nested.billing_next_due_at) ||
    asText(nested.billing_date) ||
    asText(nested.next_due) ||
    asText(nested.next_due_at) ||
    asText(nested.next_due_on) ||
    asText(nested.renewal_date) ||
    asText(nested.renewal_at) ||
    asText(record.billing_start_at) ||
    asText(record.billing_next_due_at) ||
    asText(record.billing_date) ||
    asText(record.next_due) ||
    asText(record.next_due_at) ||
    asText(record.next_due_on) ||
    asText(record.renewal_date) ||
    asText(record.renewal_at) ||
    new Date().toISOString();

  return {
    title:
      asText(nested.title) ||
      asText(record.title) ||
      asText(record.name) ||
      "Migrated Contract",
    impact:
      asText(nested.impact) || asText(record.impact) || "Unspecified",
    status: asText(nested.status) || asText(record.status) || "Active",
    billing_cycle:
      asText(nested.billing_cycle) ||
      asText(record.billing_cycle) ||
      "Monthly",
    billing_cost_subunits:
      typeof nested.billing_cost_subunits === "number"
        ? nested.billing_cost_subunits
        : typeof record.billing_cost_subunits === "number"
        ? record.billing_cost_subunits
        : 0,
    billing_cost_type:
      asText(nested.billing_cost_type) ||
      asText(record.billing_cost_type) ||
      "Estimate",
    billing_start_at: resolvedBillingStartAt,
    should_budget_past_end_date:
      nested.should_budget_past_end_date ??
      record.should_budget_past_end_date ??
      false,
    ...(asText(nested.description) ||
    asText(record.description) ||
    asText(record.summary)
      ? {
          description:
            asText(nested.description) ||
            asText(record.description) ||
            asText(record.summary),
        }
      : {}),
    ...(asText(nested.category) || asText(record.category)
      ? { category: asText(nested.category) || asText(record.category) }
      : {}),
    ...(asText(nested.location) || asText(record.location)
      ? { location: asText(nested.location) || asText(record.location) }
      : {}),
    ...((nested.is_third_party ?? record.is_third_party) != null
      ? { is_third_party: nested.is_third_party ?? record.is_third_party }
      : {}),
    ...((nested.billing_per_seat_cost_subunits ??
      record.billing_per_seat_cost_subunits) != null
      ? {
          billing_per_seat_cost_subunits:
            nested.billing_per_seat_cost_subunits ??
            record.billing_per_seat_cost_subunits,
        }
      : {}),
    ...((nested.billing_number_of_seats ?? record.billing_number_of_seats) !=
    null
      ? {
          billing_number_of_seats:
            nested.billing_number_of_seats ?? record.billing_number_of_seats,
        }
      : {}),
    ...((nested.billing_is_auto_renew ?? record.billing_is_auto_renew) != null
      ? {
          billing_is_auto_renew:
            nested.billing_is_auto_renew ?? record.billing_is_auto_renew,
        }
      : {}),
    ...(isIsoDateTime(nested.end_at) || isIsoDateTime(record.end_at)
      ? {
          end_at: isIsoDateTime(nested.end_at) ? nested.end_at : record.end_at,
        }
      : {}),
    ...((nested.notify_days_before_end_date ??
      record.notify_days_before_end_date) != null
      ? {
          notify_days_before_end_date:
            nested.notify_days_before_end_date ??
            record.notify_days_before_end_date,
        }
      : {}),
    ...((nested.is_billable ?? record.is_billable) != null
      ? { is_billable: nested.is_billable ?? record.is_billable }
      : {}),
  };
}

function collectShortIdCandidates(
  value: unknown,
  results: Set<string>,
  keyHint?: string
) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const looksLikeIdentifier = keyHint
      ? /(id|number|key|code|reference|ref)$/i.test(keyHint)
      : false;
    if (
      looksLikeIdentifier &&
      trimmed.length >= 5 &&
      trimmed.length <= 16 &&
      !trimmed.includes(" ") &&
      !trimmed.includes("-")
    ) {
      results.add(trimmed);
    }
    return;
  }

  if (typeof value === "number") {
    if (keyHint && /(id|number|key|code|reference|ref)$/i.test(keyHint)) {
      const text = String(value);
      if (text.length >= 5 && text.length <= 16) {
        results.add(text);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectShortIdCandidates(item, results, keyHint);
    return;
  }

  if (isRecord(value)) {
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      collectShortIdCandidates(nestedValue, results, nestedKey);
    }
  }
}

function getShortClientIdCandidate(
  client: MigrationClient | Record<string, unknown>
): string | null {
  const candidates = [
    client.client_id,
    client.client_number,
    client.key,
    client.reference,
    client.short_id,
    client.code,
  ];

  for (const candidate of candidates) {
    const value = asText(candidate);
    if (
      value &&
      value.length >= 5 &&
      value.length <= 16 &&
      !value.includes(" ") &&
      !value.includes("-")
    ) {
      return value;
    }
  }

  const discovered = new Set<string>();
  collectShortIdCandidates(client, discovered);
  return [...discovered][0] || null;
}

function buildRecordNameLookup(records: Record<string, any>[]) {
  const lookup = new Map<string, string>();
  for (const record of records) {
    const id = asText(record.id);
    if (!id) continue;
    lookup.set(id, getRecordName(record, "Unnamed record"));
  }
  return lookup;
}

async function fetchRelationshipIdList(
  apiKey: string,
  endpoint: string,
  responseKey: string
): Promise<string[]> {
  const response = await proxyCallWithRetry<Record<string, unknown>>(
    apiKey,
    endpoint
  );
  const items = response[responseKey];
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => asText(item))
    .filter((item): item is string => Boolean(item));
}

async function collectClientRelationshipsFromSource(
  sourceApiKey: string,
  sourceRecords: Partial<
    Record<Exclude<MigrationObjectType, "relationships">, Record<string, any>[]>
  >
): Promise<PendingRelationship[]> {
  const relationships: PendingRelationship[] = [];
  const goals = sourceRecords.goals || [];
  const initiatives = sourceRecords.initiatives || [];
  const actionItems = sourceRecords.actionItems || [];
  const meetings = sourceRecords.meetings || [];

  const goalNames = buildRecordNameLookup(goals);
  const initiativeNames = buildRecordNameLookup(initiatives);
  const actionItemNames = buildRecordNameLookup(actionItems);
  const meetingNames = buildRecordNameLookup(meetings);
  const seen = new Set<string>();

  const pushRelationship = (relationship: PendingRelationship) => {
    const key = [
      relationship.type,
      relationship.sourceSourceId,
      relationship.targetSourceId,
    ].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    relationships.push(relationship);
  };

  for (const goal of goals) {
    const goalId = asText(goal.id);
    if (!goalId) continue;
    const goalName = goalNames.get(goalId) || "Unnamed Goal";

    const initiativeIds = await fetchRelationshipIdList(
      sourceApiKey,
      `/lifecycle-manager/v1/goals/${goalId}/initiatives`,
      "initiative_ids"
    );
    for (const initiativeId of initiativeIds) {
      pushRelationship({
        clientName: "",
        type: "Goal ↔ Initiative",
        sourceRecord: goalName,
        targetRecord:
          initiativeNames.get(initiativeId) || "Initiative",
        sourceSourceId: goalId,
        targetSourceId: initiativeId,
      });
    }

    const meetingIds = await fetchRelationshipIdList(
      sourceApiKey,
      `/lifecycle-manager/v1/goals/${goalId}/meetings`,
      "meeting_ids"
    );
    for (const meetingId of meetingIds) {
      pushRelationship({
        clientName: "",
        type: "Goal ↔ Meeting",
        sourceRecord: goalName,
        targetRecord: meetingNames.get(meetingId) || "Meeting",
        sourceSourceId: goalId,
        targetSourceId: meetingId,
      });
    }
  }

  for (const initiative of initiatives) {
    const initiativeId = asText(initiative.id);
    if (!initiativeId) continue;
    const initiativeName =
      initiativeNames.get(initiativeId) || "Unnamed Initiative";

    const actionItemIds = await fetchRelationshipIdList(
      sourceApiKey,
      `/lifecycle-manager/v1/initiatives/${initiativeId}/action-items`,
      "action_item_ids"
    );
    for (const actionItemId of actionItemIds) {
      pushRelationship({
        clientName: "",
        type: "Initiative ↔ Action Item",
        sourceRecord: initiativeName,
        targetRecord:
          actionItemNames.get(actionItemId) || "Action Item",
        sourceSourceId: initiativeId,
        targetSourceId: actionItemId,
      });
    }
  }

  for (const meeting of meetings) {
    const meetingId = asText(meeting.id);
    if (!meetingId) continue;
    const meetingName = meetingNames.get(meetingId) || "Unnamed Meeting";

    const initiativeIds = await fetchRelationshipIdList(
      sourceApiKey,
      `/lifecycle-manager/v1/meetings/${meetingId}/initiatives`,
      "initiative_ids"
    );
    for (const initiativeId of initiativeIds) {
      pushRelationship({
        clientName: "",
        type: "Initiative ↔ Meeting",
        sourceRecord: initiativeNames.get(initiativeId) || "Initiative",
        targetRecord: meetingName,
        sourceSourceId: initiativeId,
        targetSourceId: meetingId,
      });
    }

    const actionItemIds = await fetchRelationshipIdList(
      sourceApiKey,
      `/lifecycle-manager/v1/meetings/${meetingId}/action-items`,
      "action_item_ids"
    );
    for (const actionItemId of actionItemIds) {
      pushRelationship({
        clientName: "",
        type: "Meeting ↔ Action Item",
        sourceRecord: meetingName,
        targetRecord: actionItemNames.get(actionItemId) || "Action Item",
        sourceSourceId: meetingId,
        targetSourceId: actionItemId,
      });
    }

    if (meeting.agenda_json) {
      pushRelationship({
        clientName: "",
        type: "Meeting Notes",
        sourceRecord: meetingName,
        targetRecord: "Agenda / Notes",
        sourceSourceId: meetingId,
        targetSourceId: meetingId,
      });
    }
  }

  for (const actionItem of actionItems) {
    const actionItemId =
      asText(actionItem.engagement_action_id) || asText(actionItem.id) || null;
    if (!actionItemId) continue;

    const actionItemName =
      actionItemNames.get(asText(actionItem.id) || actionItemId) ||
      getRecordName(actionItem, "Action Item");

    const initiativeLinks = Array.isArray(actionItem.initiative_links)
      ? actionItem.initiative_links
      : actionItem.initiative_links
      ? [actionItem.initiative_links]
      : [];

    for (const initiativeLink of initiativeLinks) {
      const initiativeId =
        asText(initiativeLink?.initiative_id) ||
        asText(initiativeLink?.id) ||
        null;
      if (!initiativeId) continue;
      pushRelationship({
        clientName: "",
        type: "Initiative ↔ Action Item",
        sourceRecord:
          initiativeNames.get(initiativeId) || "Initiative",
        targetRecord: actionItemName,
        sourceSourceId: initiativeId,
        targetSourceId: actionItemId,
      });
    }
  }

  return relationships;
}

function buildMemberEmailFilterValue(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  return /[\s,"]/.test(normalizedEmail)
    ? `eq:"${normalizedEmail.replace(/"/g, '\\"')}"`
    : `eq:${normalizedEmail}`;
}

async function fetchDestinationMembersPage(
  apiKey: string,
  cursor: string | null,
  includePageSize: boolean
) {
  const params = new URLSearchParams();
  if (includePageSize) params.set("page_size", "200");
  if (cursor) params.set("cursor", cursor);

  const endpoint = params.size
    ? `/core/v1/members?${params.toString()}`
    : "/core/v1/members";

  return proxyCallWithRetry<{
    data?: Record<string, unknown>[];
    next_cursor?: string | null;
  }>(apiKey, endpoint, "POST");
}

async function fetchDestinationMembers(
  apiKey: string
): Promise<DestinationMember[]> {
  const results: DestinationMember[] = [];
  let cursor: string | null = null;
  let includePageSize = true;

  do {
    let response: {
      data?: Record<string, unknown>[];
      next_cursor?: string | null;
    };
    try {
      response = await fetchDestinationMembersPage(
        apiKey,
        cursor,
        includePageSize
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      if (
        includePageSize &&
        /Unexpected property 'page_size'|Only 'filter' is supported/i.test(detail)
      ) {
        includePageSize = false;
        response = await fetchDestinationMembersPage(apiKey, cursor, false);
      } else {
        throw error;
      }
    }

    for (const member of response.data || []) {
      const id = asText(member.id);
      const email = asText(member.contact_info?.email) || asText(member.email);
      if (id && email) {
        results.push({ id, email: email.toLowerCase() });
      }
    }

    cursor = response.next_cursor || null;
  } while (cursor);

  return results;
}

async function fetchDestinationMeetingTypes(
  apiKey: string
): Promise<DestinationMeetingType[]> {
  const response = await proxyCallWithRetry<{
    data?: Record<string, unknown>[];
  }>(apiKey, "/lifecycle-manager/v1/meeting-types");

  return (response.data || [])
    .map((item) => {
      const id =
        asText(item.meeting_type_id) || asText(item.id) || null;
      const label = asText(item.label);
      return id && label ? { id, label } : null;
    })
    .filter((item): item is DestinationMeetingType => Boolean(item));
}

async function findDestinationMemberIdByEmailViaApi(
  apiKey: string,
  email: string | null | undefined
): Promise<string | null> {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) return null;

  try {
    const response = await proxyCallWithRetry<{
      data?: Record<string, unknown>[];
    }>(apiKey, "/core/v1/members", "POST", {
      filter: {
        "contact_info.email": buildMemberEmailFilterValue(normalizedEmail),
      },
    });

    const match = (response.data || []).find((member) => {
      const memberEmail =
        asText(member.contact_info?.email) || asText(member.email);
      return memberEmail?.trim().toLowerCase() === normalizedEmail;
    });

    if (match) {
      return asText(match.id);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (!detail.startsWith("400")) {
      throw error;
    }
  }

  const members = await fetchDestinationMembers(apiKey);
  return findDestinationMemberIdByEmail(members, normalizedEmail);
}

function findDestinationMemberIdByEmail(
  members: DestinationMember[],
  email: string | null | undefined
) {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) return null;
  return members.find((member) => member.email === normalizedEmail)?.id || null;
}

async function candidateWorksForDeliverables(
  apiKey: string,
  candidate: string
): Promise<{ works: boolean; detail?: string }> {
  try {
    await proxyCallWithRetry(
      apiKey,
      `/lifecycle-manager/v1/clients/${encodeURIComponent(
        candidate
      )}/deliverables?page_size=1`
    );
    return { works: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (detail.startsWith("404") || detail.startsWith("422")) {
      return { works: false, detail };
    }
    throw error;
  }
}

async function resolveDeliverableClientId(
  apiKey: string,
  client: MigrationClient,
  cache: Map<string, string>
): Promise<string> {
  const cached = cache.get(client.id);
  if (cached) return cached;
  const directResult = await candidateWorksForDeliverables(apiKey, client.id);
  if (directResult.works) {
    cache.set(client.id, client.id);
    return client.id;
  }

  throw buildApiError(
    "Deliverables skipped - source client id was rejected by the deliverables endpoint.",
    `/lifecycle-manager/v1/clients/${encodeURIComponent(client.id)}/deliverables`,
    "GET",
    {
      source_client_id: client.id,
      source_client_name: client.name,
      attempted_candidates: [
        {
          candidate: client.id,
          result: directResult.detail || "unusable",
        },
      ],
      source_client_record: client,
    }
  );
}

function normalizeTemplateTitle(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized || null;
}

async function fetchAssessmentTemplates(
  apiKey: string
): Promise<AssessmentTemplateOverview[]> {
  const response = await proxyCallWithRetry<{
    data?: Record<string, unknown>[];
  }>(apiKey, "/lifecycle-manager/v1/assessment-templates");

  return (response.data || [])
    .map((item) => {
      const id = asText(item.assessment_template_id) || asText(item.id);
      const title = asText(item.title);
      return id && title ? { id, title } : null;
    })
    .filter((item): item is AssessmentTemplateOverview => Boolean(item));
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function remapDeliverableComponentConfiguration(
  componentKey: string,
  configuration: unknown,
  sourceAssessmentTemplateTitlesById: Map<string, string>,
  destinationAssessmentTemplateIdsByTitle: Map<string, string>
) {
  if (componentKey !== "Assessments" || configuration === undefined) {
    return configuration;
  }

  const clonedConfiguration = cloneJsonValue(configuration);
  if (!isRecord(clonedConfiguration) || !isRecord(clonedConfiguration.data)) {
    return clonedConfiguration;
  }

  const assessmentReports = Array.isArray(clonedConfiguration.data.assessment_reports)
    ? clonedConfiguration.data.assessment_reports
    : [];

  for (const report of assessmentReports) {
    if (!isRecord(report)) continue;

    const sourceTemplateId = asText(report.assessment_template_id);
    if (!sourceTemplateId) continue;

    const sourceTemplateTitle =
      sourceAssessmentTemplateTitlesById.get(sourceTemplateId) || null;

    if (!sourceTemplateTitle) {
      throw new Error(
        `Deliverable skipped - source assessment template ${sourceTemplateId} could not be resolved.`
      );
    }

    const destinationTemplateId =
      destinationAssessmentTemplateIdsByTitle.get(
        normalizeTemplateTitle(sourceTemplateTitle) || ""
      ) || null;

    if (!destinationTemplateId) {
      throw new Error(
        `Deliverable skipped - destination assessment template '${sourceTemplateTitle}' could not be resolved.`
      );
    }

    report.assessment_template_id = destinationTemplateId;
  }

  return clonedConfiguration;
}

function buildDeliverableCreatePayload(
  record: Record<string, any>,
  sourceAssessmentTemplateTitlesById: Map<string, string>,
  destinationAssessmentTemplateIdsByTitle: Map<string, string>
) {
  const sourceSections = Array.isArray(record.sections) ? record.sections : [];

  return {
    name: asText(record.name) || asText(record.title) || "Migrated Deliverable",
    sections: sourceSections.map((section, sectionIndex) => {
      const sourceComponents = Array.isArray(section?.components)
        ? section.components
        : [];

      return {
        section_key:
          asText(section?.section_key) ||
          asText(section?.name) ||
          `Section${sectionIndex + 1}`,
        display_order:
          typeof section?.display_order === "number"
            ? section.display_order
            : sectionIndex + 1,
        ...(asText(section?.summary_json)
          ? { summary_json: asText(section.summary_json) }
          : {}),
        components: sourceComponents
          .map((component) => {
            const componentKey = asText(component?.component_key);
            const componentTypeConfiguration = isRecord(
              component?.component_type_configuration
            )
              ? component.component_type_configuration
              : null;

            if (!componentKey || !componentTypeConfiguration) {
              return null;
            }

            return {
              component_key: componentKey,
              component_type_configuration: componentTypeConfiguration,
              ...(component?.configuration !== undefined
                ? {
                    configuration: remapDeliverableComponentConfiguration(
                      componentKey,
                      component.configuration,
                      sourceAssessmentTemplateTitlesById,
                      destinationAssessmentTemplateIdsByTitle
                    ),
                  }
                : {}),
            };
          })
          .filter(
            (
              component
            ): component is {
              component_key: string;
              component_type_configuration: Record<string, unknown>;
              configuration?: unknown;
            } => Boolean(component)
          ),
      };
    }),
  };
}

function collectRelationships(
  type: Exclude<MigrationObjectType, "relationships">,
  record: Record<string, any>
): PendingRelationship[] {
  if (type !== "actionItems") return [];

  const recordName = getRecordName(record, "Unnamed record");
  const actionItemId =
    asText(record.engagement_action_id) || asText(record.id) || null;

  if (!actionItemId) return [];

  const relationships: PendingRelationship[] = [];

  const initiativeLink = Array.isArray(record.initiative_links)
    ? record.initiative_links[0]
    : record.initiative_links;
  const initiativeId =
    asText(initiativeLink?.initiative_id) || asText(initiativeLink?.id) || null;
  if (initiativeId) {
    relationships.push({
      clientName: "",
      type: "Initiative ↔ Action Item",
      sourceRecord: recordName,
      targetRecord: "Initiative",
      sourceSourceId: initiativeId,
      targetSourceId: actionItemId,
    });
  }

  const goalLinks = Array.isArray(record.goal_links) ? record.goal_links : [];
  for (const goalLink of goalLinks) {
    const goalId = asText(goalLink?.goal_id) || asText(goalLink?.id) || null;
    if (goalId) {
      relationships.push({
        clientName: "",
        type: "Goal ↔ Action Item",
        sourceRecord: recordName,
        targetRecord: "Goal",
        sourceSourceId: goalId,
        targetSourceId: actionItemId,
      });
    }
  }

  const meetingLink = Array.isArray(record.meeting_links)
    ? record.meeting_links[0]
    : record.meeting_links;
  const meetingId =
    asText(meetingLink?.meeting_id) || asText(meetingLink?.id) || null;
  if (meetingId) {
    relationships.push({
      clientName: "",
      type: "Meeting ↔ Action Item",
      sourceRecord: recordName,
      targetRecord: "Meeting",
      sourceSourceId: meetingId,
      targetSourceId: actionItemId,
    });
  }

  return relationships;
}

async function fetchObjectRecords(
  apiKey: string,
  type: Exclude<MigrationObjectType, "relationships">,
  client: MigrationClient,
  deliverableClientIdCache: Map<string, string>
): Promise<Record<string, any>[]> {
  if (type === "deliverables") {
    const deliverableClientId = await resolveDeliverableClientId(
      apiKey,
      client,
      deliverableClientIdCache
    );

    const deliverables = await fetchAllPages<Record<string, any>>(
      apiKey,
      (cursor) => {
        const params = new URLSearchParams({ page_size: "100" });
        if (cursor) params.set("cursor", cursor);
        const endpoint = `/lifecycle-manager/v1/clients/${encodeURIComponent(
          deliverableClientId
        )}/deliverables?${params.toString()}`;
        console.debug("Tenant Migration deliverables read URL:", endpoint);
        return endpoint;
      }
    );

    const detailed: Record<string, any>[] = [];
    for (const item of deliverables) {
      await sleep(DEFAULT_DELAY_MS);
      const detailResponse = await proxyCallWithRetry<Record<string, any>>(
        apiKey,
        `/lifecycle-manager/v1/deliverables/${item.id}`
      );
      const deliverableRecord =
        isRecord(detailResponse.deliverable) && detailResponse.deliverable
          ? detailResponse.deliverable
          : detailResponse;
      detailed.push({
        ...item,
        ...deliverableRecord,
      });
    }
    return detailed;
  }

  const endpointBase =
    type === "actionItems"
      ? "/lifecycle-manager/v1/action-items"
      : `/lifecycle-manager/v1/${type}`;

  const list = await fetchAllPages<Record<string, any>>(
    apiKey,
    (cursor) => {
      const params = new URLSearchParams({
        "filter[client.id]": client.id,
        page_size: "100",
      });
      if (cursor) params.set("cursor", cursor);
      return `${endpointBase}?${params.toString()}`;
    }
  );

  if (type !== "assessments" && type !== "meetings") return list;

  const detailed: Record<string, any>[] = [];
  for (const item of list) {
    await sleep(DEFAULT_DELAY_MS);
    const detailResponse = await proxyCallWithRetry<Record<string, any>>(
      apiKey,
      `${endpointBase}/${item.id}`
    );
    const detailRecord =
      (type === "meetings" &&
        isRecord(detailResponse.meeting) &&
        detailResponse.meeting) ||
      (type === "assessments" &&
        isRecord(detailResponse.assessment) &&
        detailResponse.assessment) ||
      detailResponse;

    detailed.push({
      ...item,
      ...detailRecord,
      ...(type === "meetings" &&
      isRecord(detailRecord.meeting_type) &&
      !detailRecord.type
        ? { type: asText(detailRecord.meeting_type.label) || null }
        : {}),
    });
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
  actionItemAssigneeEmail?: string | null,
  destinationMembers: DestinationMember[] = [],
  destinationMeetingTypes: DestinationMeetingType[] = [],
  deliverableClientIdCache: Map<string, string> = new Map(),
  sourceAssessmentTemplateTitlesById: Map<string, string> = new Map(),
  destinationAssessmentTemplateIdsByTitle: Map<string, string> = new Map()
): Promise<{
  newId?: string;
  recordName: string;
  relationships: PendingRelationship[];
  warnings: MigrationErrorEntry[];
  debugDiagnostic?: MigrationDebugEntry;
}> {
  const destinationClientId = destinationClient.id;
  const recordName = getRecordName(
    record,
    `Unnamed ${OBJECT_LABELS[type]}`
  );
  const warnings: MigrationErrorEntry[] = [];

  if (type === "initiatives") {
    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/initiatives",
      "POST",
      {
        client_key: { id: destinationClientId },
        name:
          asText(record.name) || asText(record.title) || "Untitled Initiative",
        executive_summary: asText(record.executive_summary) || "",
      }
    );

    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(
      destinationApiKey,
      `/lifecycle-manager/v1/initiatives/${created.id}/status`,
      "PUT",
      { status: asText(record.status) || "New" }
    );
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(
      destinationApiKey,
      `/lifecycle-manager/v1/initiatives/${created.id}/priority`,
      "PUT",
      { priority: asText(record.priority) || "None" }
    );
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(
      destinationApiKey,
      `/lifecycle-manager/v1/initiatives/${created.id}/schedule`,
      "PUT",
      { fiscal_quarter: record.fiscal_quarter || null }
    );
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(
      destinationApiKey,
      `/lifecycle-manager/v1/initiatives/${created.id}/budget`,
      "PUT",
      { budget_line_items: record.budget?.line_items || [] }
    );
    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(
      destinationApiKey,
      `/lifecycle-manager/v1/initiatives/${created.id}/recurring`,
      "PUT",
      { recurring_line_items: record.budget?.recurring_line_items || [] }
    );

    return {
      newId: created.id,
      recordName,
      relationships: collectRelationships(type, record),
      warnings,
    };
  }

  if (type === "goals") {
    const body = {
      client_key: { id: destinationClientId },
      title: asText(record.title) || "Untitled Goal",
      description: asText(record.description) || "",
      status: asText(record.status) || "OnTrack",
      target_period: record.target_period || record.period || null,
    };

    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/goals",
      "POST",
      body
    );

    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(
      destinationApiKey,
      `/lifecycle-manager/v1/goals/${created.id}`,
      "PUT",
      {
        title: body.title,
        description: body.description,
        status: body.status,
        target_period: body.target_period,
      }
    );

    return {
      newId: created.id,
      recordName,
      relationships: collectRelationships(type, record),
      warnings,
    };
  }

  if (type === "notes") {
    const title =
      asText(record.title) ||
      asText(record.subject) ||
      asText(record.name) ||
      "Migrated Note";
    const noteText =
      asText(record.description) ||
      asText(record.content) ||
      asText(record.body) ||
      asText(record.text) ||
      title;
    const descriptionJson = buildProseMirrorJson(noteText);

    const createBody = {
      client_key: { id: destinationClientId },
      title,
      description_json: descriptionJson,
    };
    const updateBody = {
      title,
      description_json: descriptionJson,
    };

    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/notes",
      "POST",
      createBody
    );

    await sleep(DEFAULT_DELAY_MS);
    await proxyCallWithRetry(
      destinationApiKey,
      `/lifecycle-manager/v1/notes/${created.id}`,
      "PUT",
      updateBody
    );

    return { newId: created.id, recordName, relationships: [], warnings };
  }

  if (type === "actionItems") {
    const assigneeEmail =
      extractActionItemAssigneeEmail(record) || actionItemAssigneeEmail || null;
    const matchedUserId =
      findDestinationMemberIdByEmail(destinationMembers, assigneeEmail) ||
      (await findDestinationMemberIdByEmailViaApi(
        destinationApiKey,
        assigneeEmail
      ));

    if (!assigneeEmail) {
      throw new Error("Skipped - no assignee available.");
    }

    const body = {
      client_key: { id: destinationClientId },
      description: asText(record.description) || "Migrated action item",
      assigned_user_ids: [{ email: assigneeEmail }],
      due_at: normalizeDueAt(record.due_at),
    };

    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/action-items",
      "POST",
      body
    );

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
      warnings,
      debugDiagnostic: {
        clientName: destinationClient.name,
        objectType: OBJECT_LABELS.actionItems,
        recordName,
        resolvedEmail: assigneeEmail,
        resolvedUserId: matchedUserId,
        sourceUserId:
          asText(record.assigned_user?.id) ||
          asText(record.assignee?.id) ||
          asText(record.assigned_user_id) ||
          null,
        note: "Action Item assignee resolution",
      },
    };
  }

  if (type === "contracts") {
    const billingStartAt =
      asText(record.billing_start_at) ||
      asText(record.billing_next_due_at) ||
      asText(record.billing_date) ||
      asText(record.next_due) ||
      asText(record.next_due_at) ||
      asText(record.next_due_on) ||
      asText(record.renewal_date) ||
      asText(record.renewal_at) ||
      new Date().toISOString();
    const contractTitle =
      asText(record.title) || asText(record.name) || "Migrated Contract";

    if (
      !asText(record.billing_start_at) &&
      !asText(record.billing_next_due_at) &&
      !asText(record.billing_date) &&
      !asText(record.next_due) &&
      !asText(record.next_due_at) &&
      !asText(record.next_due_on) &&
      !asText(record.renewal_date) &&
      !asText(record.renewal_at)
    ) {
      warnings.push(
        buildWarning(
          destinationClient.name,
          OBJECT_LABELS.contracts,
          recordName,
          "billing_start_at was missing on source - defaulted to today"
        )
      );
    }

    if (!asText(record.title) && !asText(record.name)) {
      warnings.push(
        buildWarning(
          destinationClient.name,
          OBJECT_LABELS.contracts,
          recordName,
          "Contract title was missing on source - used 'Migrated Contract'"
        )
      );
    }

    const body = {
      client_key: { id: destinationClientId },
      create_payload: {
        ...buildContractCreatePayload(record),
        title: contractTitle,
        billing_start_at: billingStartAt,
      },
    };

    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/contracts",
      "POST",
      body
    );

    return { newId: created.id, recordName, relationships: [], warnings };
  }

  if (type === "assessments") {
    const templateId = asText(record.assessment_template_id);
    const preferredEvaluatorEmail =
      actionItemAssigneeEmail || extractAssessmentEvaluatorEmail(record) || null;
    const evaluatorUserId =
      findDestinationMemberIdByEmail(destinationMembers, preferredEvaluatorEmail) ||
      (await findDestinationMemberIdByEmailViaApi(
        destinationApiKey,
        preferredEvaluatorEmail
      ));

    if (!templateId) {
      throw new Error(
        "Skipped - assessment_template_id is missing on the source assessment."
      );
    }

    if (!evaluatorUserId) {
      const error = new Error(
        `Skipped - evaluate_user_id could not be resolved in the destination tenant for ${preferredEvaluatorEmail || "the configured fallback user"}.`
      ) as Error & {
        resolvedEmail?: string | null;
        resolvedUserId?: string | null;
        sourceUserId?: string | null;
      };
      error.resolvedEmail = preferredEvaluatorEmail;
      error.resolvedUserId = null;
      error.sourceUserId = asText(record.evaluate_user_id);
      throw error;
    }

    const body = {
      client_key: { id: destinationClientId },
      title: asText(record.title) || "Migrated Assessment",
      assessment_template_id: templateId,
      evaluate_user_id: evaluatorUserId,
      evaluate_at:
        (isIsoDateTime(record.evaluate_at) && record.evaluate_at) ||
        (isIsoDateTime(record.record_updated_at) && record.record_updated_at) ||
        new Date().toISOString(),
    };

    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/assessments",
      "POST",
      body
    );

    if (
      asText(record.status) === "Completed" ||
      asText(record.completion_status)
    ) {
      await sleep(DEFAULT_DELAY_MS);
      await proxyCallWithRetry(
        destinationApiKey,
        `/lifecycle-manager/v1/assessments/${created.id}/completion-status`,
        "PUT",
        { is_completed: true }
      );
    }

    warnings.push(
      buildWarning(
        destinationClient.name,
        OBJECT_LABELS.assessments,
        recordName,
        "Assessment created. Answers not replayed - requires manual re-evaluation in destination tenant."
      )
    );

    return {
      newId: created.id,
      recordName,
      relationships: [],
      warnings,
      debugDiagnostic: {
        clientName: destinationClient.name,
        objectType: OBJECT_LABELS.assessments,
        recordName,
        resolvedEmail: preferredEvaluatorEmail,
        resolvedUserId: evaluatorUserId,
        sourceUserId: asText(record.evaluate_user_id),
        note: "Assessment evaluator resolution",
      },
    };
  }

  if (type === "meetings") {
    const meetingTypeId = resolveMeetingTypeId(record, destinationMeetingTypes);
    const body = {
      client_key: { id: destinationClientId },
      title:
        asText(record.title) ||
        asText(record.name) ||
        asText(record.subject) ||
        asText(record.topic) ||
        "Untitled Meeting",
      type: meetingTypeId,
      starts_at: isIsoDateTime(record.starts_at) ? record.starts_at : null,
      ends_at: isIsoDateTime(record.ends_at) ? record.ends_at : null,
      agenda_json: record.agenda_json ?? null,
    };

    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v2/meetings",
      "POST",
      body
    );

    if (!meetingTypeId) {
      warnings.push(
        buildWarning(
          destinationClient.name,
          OBJECT_LABELS.meetings,
          recordName,
          "Meeting type ID was unavailable on source - created meeting without a type."
        )
      );
    }

    if (record.completion_status) {
      await sleep(DEFAULT_DELAY_MS);
      await proxyCallWithRetry(
        destinationApiKey,
        `/lifecycle-manager/v1/meetings/${created.id}/completion-status`,
        "PUT",
        { completion_status: record.completion_status }
      );
    }

    const userIds = extractIds(
      record.attendees?.users || record.attendee_users || record.users
    );
    if (userIds.length > 0) {
      await sleep(DEFAULT_DELAY_MS);
      await proxyCallWithRetry(
        destinationApiKey,
        `/lifecycle-manager/v1/meetings/${created.id}/attendees/users`,
        "POST",
        { user_ids: userIds }
      );
    }

    const contactIds = extractIds(
      record.attendees?.contacts ||
        record.attendee_contacts ||
        record.contacts
    );
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
      warnings,
    };
  }

  const deliverableClientId = await resolveDeliverableClientId(
    destinationApiKey,
    destinationClient,
    deliverableClientIdCache
  );
  const createBody = buildDeliverableCreatePayload(
    record,
    sourceAssessmentTemplateTitlesById,
    destinationAssessmentTemplateIdsByTitle
  );
  if (
    !Array.isArray(createBody.sections) ||
    createBody.sections.length === 0
  ) {
    throw new Error(
      "Deliverable skipped - source deliverable did not include any migratable sections."
    );
  }
  const createEndpoint = `/lifecycle-manager/v1/clients/${encodeURIComponent(
    deliverableClientId
  )}/deliverables`;
  console.debug("Tenant Migration deliverables write URL:", createEndpoint);

  const created = await proxyCallWithRetry<{ deliverable?: { id?: string } }>(
    destinationApiKey,
    createEndpoint,
    "POST",
    createBody
  );

  const createdId = asText(created.deliverable?.id);
  if (!createdId) {
    throw new Error("Deliverable create did not return a deliverable id.");
  }

  const createdDeliverable = await proxyCallWithRetry<Record<string, any>>(
    destinationApiKey,
    `/lifecycle-manager/v1/deliverables/${createdId}`
  );
  const createdSections =
    isRecord(createdDeliverable.deliverable) &&
    Array.isArray(createdDeliverable.deliverable.sections)
      ? createdDeliverable.deliverable.sections
      : Array.isArray(createdDeliverable.sections)
      ? createdDeliverable.sections
      : [];

  if (createdSections.length !== createBody.sections.length) {
    warnings.push(
      buildWarning(
        destinationClient.name,
        OBJECT_LABELS.deliverables,
        getRecordName(record, "Migrated Deliverable"),
        "Deliverable created, but destination section count did not match source configuration."
      )
    );
  }

  return {
    newId: createdId,
    recordName,
    relationships: [],
    warnings,
  };
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
        endpoint =
          goalId && initiativeId
            ? `/lifecycle-manager/v1/goals/${goalId}/initiatives/${initiativeId}`
            : null;
      } else if (item.type === "Goal ↔ Meeting") {
        const goalId = idMaps.goals.get(item.sourceSourceId);
        const meetingId = idMaps.meetings.get(item.targetSourceId);
        endpoint =
          goalId && meetingId
            ? `/lifecycle-manager/v1/goals/${goalId}/meetings/${meetingId}`
            : null;
      } else if (item.type === "Initiative ↔ Meeting") {
        const initiativeId = idMaps.initiatives.get(item.sourceSourceId);
        const meetingId = idMaps.meetings.get(item.targetSourceId);
        endpoint =
          initiativeId && meetingId
            ? `/lifecycle-manager/v1/initiatives/${initiativeId}/meetings/${meetingId}`
            : null;
      } else if (item.type === "Initiative ↔ Action Item") {
        const initiativeId = idMaps.initiatives.get(item.sourceSourceId);
        const actionItemId = idMaps.actionItems.get(item.targetSourceId);
        endpoint =
          initiativeId && actionItemId
            ? `/lifecycle-manager/v1/initiatives/${initiativeId}/action-items/${actionItemId}`
            : null;
      } else if (item.type === "Goal ↔ Action Item") {
        const goalId = idMaps.goals.get(item.sourceSourceId);
        if (!goalId) {
          continue;
        }
        log.push({
          clientName,
          type: item.type,
          sourceRecord: item.sourceRecord,
          targetRecord: item.targetRecord,
          status: "skipped",
          detail:
            "Goal ↔ Action Item relationship not directly supported by the API - linked via Goal ↔ Initiative instead.",
        });
        continue;
      } else if (item.type === "Meeting Notes") {
        const meetingId = idMaps.meetings.get(item.sourceSourceId);
        log.push({
          clientName,
          type: item.type,
          sourceRecord: item.sourceRecord,
          targetRecord: item.targetRecord,
          status: meetingId ? "created" : "skipped",
          detail: meetingId
            ? "Meeting notes migrated with agenda_json."
            : "Linked destination record did not migrate",
        });
        continue;
      } else if (item.type === "Meeting ↔ Action Item") {
        const meetingId = idMaps.meetings.get(item.sourceSourceId);
        const actionItemId = idMaps.actionItems.get(item.targetSourceId);
        endpoint =
          meetingId && actionItemId
            ? `/lifecycle-manager/v1/meetings/${meetingId}/action-items/${actionItemId}`
            : null;
      }

      if (!endpoint) {
        log.push({
          clientName,
          type: item.type,
          sourceRecord: item.sourceRecord,
          targetRecord: item.targetRecord,
          status: "skipped",
          detail: "Linked destination record did not migrate",
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
  actionItemAssigneeEmail,
  onClientProgress,
}: RunMigrationParams): Promise<MigrationResult> {
  const clientSummaries: ClientSummary[] = [];
  const allErrors: MigrationErrorEntry[] = [];
  const relationshipLog: RelationshipLogEntry[] = [];
  const debugDiagnostics: MigrationDebugEntry[] = [];
  let totalCreated = 0;
  let totalFailures = 0;
  let destinationMembers: DestinationMember[] = [];
  let destinationMeetingTypes: DestinationMeetingType[] = [];
  let sourceAssessmentTemplates: AssessmentTemplateOverview[] = [];
  let destinationAssessmentTemplates: AssessmentTemplateOverview[] = [];

  const sourceDeliverableClientIdCache = new Map<string, string>();
  const destinationDeliverableClientIdCache = new Map<string, string>();
  const sourceClientLookup = new Map(
    sourceClients.map((client) => [client.id, client])
  );
  const destinationClientLookup = new Map(
    destinationClients.map((client) => [client.id, client])
  );

  if (selectedObjects.assessments || selectedObjects.actionItems) {
    try {
      destinationMembers = await fetchDestinationMembers(destinationApiKey);
    } catch {
      destinationMembers = [];
    }
  }

  if (selectedObjects.meetings) {
    try {
      destinationMeetingTypes = await fetchDestinationMeetingTypes(
        destinationApiKey
      );
    } catch {
      destinationMeetingTypes = [];
    }
  }

  if (selectedObjects.deliverables) {
    try {
      sourceAssessmentTemplates = await fetchAssessmentTemplates(sourceApiKey);
    } catch {
      sourceAssessmentTemplates = [];
    }

    try {
      destinationAssessmentTemplates = await fetchAssessmentTemplates(
        destinationApiKey
      );
    } catch {
      destinationAssessmentTemplates = [];
    }
  }

  const sourceAssessmentTemplateTitlesById = new Map(
    sourceAssessmentTemplates.map((template) => [template.id, template.title])
  );
  const destinationAssessmentTemplateIdsByTitle = new Map(
    destinationAssessmentTemplates
      .map((template) => [
        normalizeTemplateTitle(template.title),
        template.id,
      ] as const)
      .filter(
        (
          entry
        ): entry is readonly [string, string] => typeof entry[0] === "string"
      )
  );

  for (let clientIndex = 0; clientIndex < mappings.length; clientIndex += 1) {
    const mapping = mappings[clientIndex];
    if (mapping.skip || !mapping.dstClientId || !mapping.dstClientName) {
      continue;
    }

    const progress = buildInitialClientProgress(mapping);
    onClientProgress(clientIndex, cloneProgress(progress));

    const idMaps = getIdMaps();
    const pendingRelationships: PendingRelationship[] = [];
    const sourceRecordsByType: Partial<
      Record<Exclude<MigrationObjectType, "relationships">, Record<string, any>[]>
    > = {};
    const sourceClient = sourceClientLookup.get(mapping.srcClientId);
    const destinationClient = destinationClientLookup.get(mapping.dstClientId);

    if (!sourceClient || !destinationClient) continue;

    for (const type of OBJECT_ORDER) {
      if (!selectedObjects[type]) {
        progress.objects[type].status = "skipped";
        onClientProgress(clientIndex, cloneProgress(progress));
        continue;
      }

      progress.objects[type].status = "running";
      onClientProgress(clientIndex, cloneProgress(progress));

      let records: Record<string, any>[] = [];
      try {
        records = await fetchObjectRecords(
          sourceApiKey,
          type,
          sourceClient,
          sourceDeliverableClientIdCache
        );
        sourceRecordsByType[type] = records;
        progress.objects[type].total = records.length;
        onClientProgress(clientIndex, cloneProgress(progress));
      } catch (error) {
        const entry = buildError(
          mapping.srcClientName,
          OBJECT_LABELS[type],
          "Fetch failed",
          error
        );
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
            actionItemAssigneeEmail,
            destinationMembers,
            destinationMeetingTypes,
            destinationDeliverableClientIdCache,
            sourceAssessmentTemplateTitlesById,
            destinationAssessmentTemplateIdsByTitle
          );
          progress.objects[type].succeeded += 1;
          totalCreated += 1;

          if (result.warnings.length > 0) {
            progress.objects[type].errors.push(...result.warnings);
            allErrors.push(...result.warnings);
          }

          if (result.debugDiagnostic) {
            debugDiagnostics.push(result.debugDiagnostic);
          }

          if (type === "initiatives" && result.newId) {
            idMaps.initiatives.set(record.id, result.newId);
          }
          if (type === "goals" && result.newId) {
            idMaps.goals.set(record.id, result.newId);
          }
          if (type === "actionItems" && result.newId) {
            idMaps.actionItems.set(record.id, result.newId);
            const engagementActionId = asText(record.engagement_action_id);
            if (engagementActionId) {
              idMaps.actionItems.set(engagementActionId, result.newId);
            }
          }
          if (type === "meetings" && result.newId) {
            idMaps.meetings.set(record.id, result.newId);
          }

        } catch (error) {
          const entry = buildError(
            mapping.srcClientName,
            OBJECT_LABELS[type],
            getRecordName(record, "Unnamed record"),
            error
          );
          progress.objects[type].errors.push(entry);
          allErrors.push(entry);
          totalFailures += 1;
        }

        progress.objects[type].status = progress.objects[type].errors.some(
          (entry) => entry.severity !== "warning"
        )
          ? "partial"
          : "running";
        onClientProgress(clientIndex, cloneProgress(progress));
      }

      const blockingErrors = progress.objects[type].errors.filter(
        (entry) => entry.severity !== "warning"
      );
      progress.objects[type].status =
        blockingErrors.length === 0
          ? "success"
          : progress.objects[type].succeeded === 0
          ? "failed"
          : "partial";
      onClientProgress(clientIndex, cloneProgress(progress));
    }

    try {
      pendingRelationships.push(
        ...(
          await collectClientRelationshipsFromSource(
            sourceApiKey,
            sourceRecordsByType
          )
        ).map((item) => ({
          ...item,
          clientName: mapping.srcClientName,
        }))
      );
    } catch (error) {
      const entry = buildError(
        mapping.srcClientName,
        "Relationships",
        "Relationship harvest failed",
        error
      );
      progress.objects.relationships.errors.push(entry);
      allErrors.push(entry);
      totalFailures += 1;
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

    progress.objects.relationships.succeeded = clientRelationshipLog.filter(
      (entry) => entry.status === "created"
    ).length;
    const relationshipFailures = clientRelationshipLog.filter(
      (entry) => entry.status !== "created"
    ).length;
    progress.objects.relationships.status =
      relationshipFailures === 0
        ? "success"
        : progress.objects.relationships.succeeded > 0
        ? "partial"
        : "failed";
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

    const counts = Object.fromEntries(
      OBJECT_ORDER.map((type) => [
        type,
        {
          succeeded: progress.objects[type].succeeded,
          total: progress.objects[type].total,
        },
      ])
    ) as ClientSummary["counts"];

    const objectFailures = OBJECT_ORDER.reduce(
      (sum, type) =>
        sum +
        progress.objects[type].errors.filter(
          (entry) => entry.severity !== "warning"
        ).length,
      0
    );
    const totalRecords = OBJECT_ORDER.reduce(
      (sum, type) => sum + progress.objects[type].total,
      0
    );

    clientSummaries.push({
      clientName: mapping.srcClientName,
      destinationClientName: mapping.dstClientName,
      counts,
      status:
        objectFailures === 0
          ? "Complete"
          : totalRecords === objectFailures
          ? "Failed"
          : "Partial",
    });
  }

  return {
    clientSummaries,
    errors: allErrors,
    relationshipLog,
    totalCreated,
    totalFailures,
    debugDiagnostics,
  };
}
