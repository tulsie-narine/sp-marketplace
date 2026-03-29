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

interface PendingRelationship {
  clientName: string;
  type: RelationshipLogEntry["type"];
  sourceRecord: string;
  targetRecord: string;
  sourceSourceId: string;
  targetSourceId: string;
}

const DEFAULT_DELAY_MS = 120;
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
    billing_start_at:
      asText(nested.billing_start_at) ||
      asText(record.billing_start_at) ||
      new Date().toISOString(),
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

async function fetchDestinationMembers(
  apiKey: string
): Promise<DestinationMember[]> {
  const results: DestinationMember[] = [];
  let cursor: string | null = null;

  do {
    const params = new URLSearchParams({ page_size: "200" });
    if (cursor) params.set("cursor", cursor);
    const response = await proxyCallWithRetry<{
      data?: Record<string, unknown>[];
      next_cursor?: string | null;
    }>(apiKey, `/core/v1/members?${params.toString()}`, "POST");

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
) {
  try {
    await proxyCallWithRetry(
      apiKey,
      `/lifecycle-manager/v1/clients/${encodeURIComponent(
        candidate
      )}/deliverables?page_size=1`
    );
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (detail.startsWith("404") || detail.startsWith("422")) return false;
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

  const candidates = new Set<string>();
  const direct = getShortClientIdCandidate(client);
  if (direct) candidates.add(direct);

  const params = new URLSearchParams({ "filter[id]": client.id });
  const response = await proxyCallWithRetry<{
    data?: Record<string, unknown>[] | Record<string, unknown>;
  }>(apiKey, `/core/v1/clients?${params.toString()}`);

  const detailedClient = Array.isArray(response.data)
    ? response.data[0]
    : isRecord(response.data)
    ? response.data
    : null;

  if (detailedClient) {
    const detailedCandidate = getShortClientIdCandidate(detailedClient);
    if (detailedCandidate) candidates.add(detailedCandidate);
    const discovered = new Set<string>();
    collectShortIdCandidates(detailedClient, discovered);
    for (const candidate of discovered) {
      candidates.add(candidate);
    }
  }

  for (const candidate of candidates) {
    if (await candidateWorksForDeliverables(apiKey, candidate)) {
      cache.set(client.id, candidate);
      return candidate;
    }
  }

  throw new Error(
    "Deliverables skipped - no valid deliverables client identifier could be resolved from the client record."
  );
}

function collectRelationships(
  type: Exclude<MigrationObjectType, "relationships">,
  record: Record<string, any>
): PendingRelationship[] {
  const recordName = getRecordName(record, "Unnamed record");

  if (type === "goals") {
    return [
      ...extractIds(record.initiatives || record.linked_initiatives).map(
        (targetId) => ({
          clientName: "",
          type: "Goal <-> Initiative",
          sourceRecord: recordName,
          targetRecord: "Initiative",
          sourceSourceId: record.id,
          targetSourceId: targetId,
        })
      ),
      ...extractIds(record.meetings || record.linked_meetings).map(
        (targetId) => ({
          clientName: "",
          type: "Goal <-> Meeting",
          sourceRecord: recordName,
          targetRecord: "Meeting",
          sourceSourceId: record.id,
          targetSourceId: targetId,
        })
      ),
    ];
  }

  if (type === "initiatives") {
    return [
      ...extractIds(record.meetings || record.linked_meetings).map(
        (targetId) => ({
          clientName: "",
          type: "Initiative <-> Meeting",
          sourceRecord: recordName,
          targetRecord: "Meeting",
          sourceSourceId: record.id,
          targetSourceId: targetId,
        })
      ),
      ...extractIds(
        record.action_items ||
          record.actionItems ||
          record.linked_action_items
      ).map((targetId) => ({
        clientName: "",
        type: "Initiative <-> Action Item",
        sourceRecord: recordName,
        targetRecord: "Action Item",
        sourceSourceId: record.id,
        targetSourceId: targetId,
      })),
    ];
  }

  if (type === "meetings") {
    return extractIds(
      record.action_items || record.actionItems || record.linked_action_items
    ).map((targetId) => ({
      clientName: "",
      type: "Meeting <-> Action Item",
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
      detailed.push(
        await proxyCallWithRetry<Record<string, any>>(
          apiKey,
          `/lifecycle-manager/v1/deliverables/${item.id}`
        )
      );
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
  deliverableClientIdCache: Map<string, string> = new Map()
): Promise<{
  newId?: string;
  recordName: string;
  relationships: PendingRelationship[];
  warnings: MigrationErrorEntry[];
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
    };
  }

  if (type === "contracts") {
    const billingStartAt =
      asText(record.billing_start_at) || new Date().toISOString();
    const contractTitle =
      asText(record.title) || asText(record.name) || "Migrated Contract";

    if (!asText(record.billing_start_at)) {
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
    const evaluatorEmail =
      extractAssessmentEvaluatorEmail(record) || actionItemAssigneeEmail || null;
    const evaluatorUserId = findDestinationMemberIdByEmail(
      destinationMembers,
      evaluatorEmail
    );

    if (!templateId) {
      throw new Error(
        "Skipped - assessment_template_id is missing on the source assessment."
      );
    }

    if (!evaluatorUserId) {
      throw new Error(
        "Skipped - evaluate_user_id could not be resolved in the destination tenant."
      );
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

    return { newId: created.id, recordName, relationships: [], warnings };
  }

  if (type === "meetings") {
    const body = {
      client_key: { id: destinationClientId },
      title:
        asText(record.title) ||
        asText(record.name) ||
        asText(record.subject) ||
        asText(record.topic) ||
        "Untitled Meeting",
      type: null,
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

    warnings.push(
      buildWarning(
        destinationClient.name,
        OBJECT_LABELS.meetings,
        recordName,
        "Meeting created. Type and full details not updated - meeting type IDs are tenant-specific and cannot be migrated."
      )
    );

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
  const createBody = {
    name:
      asText(record.name) || asText(record.title) || "Migrated Deliverable",
    sections: Array.isArray(record.sections) ? record.sections : [],
  };
  const patchBody = {
    name: createBody.name,
    ...(asText(record.status) ? { status: asText(record.status) } : {}),
    sections: Array.isArray(record.sections) ? record.sections : [],
  };
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

  await sleep(DEFAULT_DELAY_MS);
  await proxyCallWithRetry(
    destinationApiKey,
    `/lifecycle-manager/v1/deliverables/${createdId}`,
    "PATCH",
    patchBody
  );

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

      if (item.type === "Goal <-> Initiative") {
        const goalId = idMaps.goals.get(item.sourceSourceId);
        const initiativeId = idMaps.initiatives.get(item.targetSourceId);
        endpoint =
          goalId && initiativeId
            ? `/lifecycle-manager/v1/goals/${goalId}/initiatives/${initiativeId}`
            : null;
      } else if (item.type === "Goal <-> Meeting") {
        const goalId = idMaps.goals.get(item.sourceSourceId);
        const meetingId = idMaps.meetings.get(item.targetSourceId);
        endpoint =
          goalId && meetingId
            ? `/lifecycle-manager/v1/goals/${goalId}/meetings/${meetingId}`
            : null;
      } else if (item.type === "Initiative <-> Meeting") {
        const initiativeId = idMaps.initiatives.get(item.sourceSourceId);
        const meetingId = idMaps.meetings.get(item.targetSourceId);
        endpoint =
          initiativeId && meetingId
            ? `/lifecycle-manager/v1/initiatives/${initiativeId}/meetings/${meetingId}`
            : null;
      } else if (item.type === "Initiative <-> Action Item") {
        const initiativeId = idMaps.initiatives.get(item.sourceSourceId);
        const actionItemId = idMaps.actionItems.get(item.targetSourceId);
        endpoint =
          initiativeId && actionItemId
            ? `/lifecycle-manager/v1/initiatives/${initiativeId}/action-items/${actionItemId}`
            : null;
      } else if (item.type === "Meeting <-> Action Item") {
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
  actionItemAssigneeEmail,
  onClientProgress,
}: RunMigrationParams): Promise<MigrationResult> {
  const clientSummaries: ClientSummary[] = [];
  const allErrors: MigrationErrorEntry[] = [];
  const relationshipLog: RelationshipLogEntry[] = [];
  let totalCreated = 0;
  let totalFailures = 0;
  let destinationMembers: DestinationMember[] = [];

  const sourceDeliverableClientIdCache = new Map<string, string>();
  const destinationDeliverableClientIdCache = new Map<string, string>();
  const sourceClientLookup = new Map(
    sourceClients.map((client) => [client.id, client])
  );
  const destinationClientLookup = new Map(
    destinationClients.map((client) => [client.id, client])
  );

  if (selectedObjects.assessments) {
    try {
      destinationMembers = await fetchDestinationMembers(destinationApiKey);
    } catch {
      destinationMembers = [];
    }
  }

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
            destinationDeliverableClientIdCache
          );
          progress.objects[type].succeeded += 1;
          totalCreated += 1;

          if (result.warnings.length > 0) {
            progress.objects[type].errors.push(...result.warnings);
            allErrors.push(...result.warnings);
          }

          if (type === "initiatives" && result.newId) {
            idMaps.initiatives.set(record.id, result.newId);
          }
          if (type === "goals" && result.newId) {
            idMaps.goals.set(record.id, result.newId);
          }
          if (type === "actionItems" && result.newId) {
            idMaps.actionItems.set(record.id, result.newId);
          }
          if (type === "meetings" && result.newId) {
            idMaps.meetings.set(record.id, result.newId);
          }

          pendingRelationships.push(
            ...result.relationships.map((item) => ({
              ...item,
              clientName: mapping.srcClientName,
            }))
          );
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
  };
}
