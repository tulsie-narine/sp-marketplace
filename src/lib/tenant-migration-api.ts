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
  tags: boolean;
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
  primaryDestinationUserId?: string | null;
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

export interface DestinationUserOption {
  id: string;
  email: string | null;
  name: string;
}

interface SourceMember {
  id: string;
  email: string;
}

interface DestinationMeetingType {
  id: string;
  label: string;
}

interface DestinationContact {
  id: string;
  email: string | null;
  clientId: string | null;
  clientName: string | null;
  label: string | null;
}

interface AssessmentTemplateOverview {
  id: string;
  title: string;
}

interface AssessmentTemplateDetail extends AssessmentTemplateOverview {
  template: Record<string, any>;
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

function normalizeInitiativeFiscalQuarter(value: unknown): {
  year: number;
  quarter: number;
} | null {
  if (!isRecord(value)) return null;
  const year = Number(value.year);
  const quarter = Number(value.quarter);
  if (!Number.isInteger(year) || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    return null;
  }

  const now = new Date();
  const currentTotal = now.getFullYear() * 4 + Math.floor(now.getMonth() / 3);
  const floorTotal = currentTotal - 4;
  const sourceTotal = year * 4 + (quarter - 1);
  const effectiveTotal = Math.max(sourceTotal, floorTotal);
  return {
    year: Math.floor(effectiveTotal / 4),
    quarter: (effectiveTotal % 4) + 1,
  };
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
      asText((item.contact_info as Record<string, unknown>)?.email) ||
      asText((item.user as Record<string, unknown>)?.email) ||
      asText((item.member as Record<string, unknown>)?.email);
    if (email) return email;
  }
  return null;
}

function extractActionItemAssigneeEmail(record: Record<string, any>) {
  return (
    asText(record.assigned_user?.email) ||
    asText(record.owner?.email) ||
    asText(record.assigned_user_email) ||
    asText(record.assignee?.email) ||
    asText(record.assignee_email) ||
    extractFirstEmail(record.assigned_user_ids) ||
    extractFirstEmail(record.assigned_users) ||
    extractFirstEmail(record.assignees) ||
    null
  );
}

function extractActionItemAssigneeEmails(record: Record<string, any>) {
  const emails = new Set<string>();
  const push = (value: unknown) => {
    const email = asText(value)?.trim().toLowerCase();
    if (email) emails.add(email);
  };

  push(record.assigned_user?.email);
  push(record.owner?.email);
  push(record.assigned_user_email);
  push(record.assignee?.email);
  push(record.assignee_email);

  for (const collection of [
    record.assigned_user_ids,
    record.assigned_users,
    record.assignees,
  ]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (typeof item === "string" && item.includes("@")) {
        push(item);
        continue;
      }
      if (!isRecord(item)) continue;
      push(item.email);
      push(item.contact_info?.email);
      push(item.user?.email);
      push(item.member?.email);
    }
  }

  return [...emails];
}

function extractActionItemAssigneeId(record: Record<string, any>) {
  return (
    asText(record.assigned_user?.id) ||
    asText(record.owner?.id) ||
    asText(record.assignee?.id) ||
    asText(record.assigned_user_id) ||
    asText(record.owner_id) ||
    asText(record.assignee_id) ||
    extractIds(record.assigned_user_ids)[0] ||
    extractIds(record.assigned_users)[0] ||
    extractIds(record.assignees)[0] ||
    null
  );
}

function extractActionItemAssigneeIds(record: Record<string, any>) {
  const ids = new Set<string>();
  const push = (value: unknown) => {
    const text = asText(value);
    if (text) ids.add(text);
  };

  push(record.assigned_user?.id);
  push(record.owner?.id);
  push(record.assignee?.id);
  push(record.assigned_user_id);
  push(record.owner_id);
  push(record.assignee_id);

  for (const collection of [
    record.assigned_user_ids,
    record.assigned_users,
    record.assignees,
  ]) {
    for (const id of extractIds(collection)) {
      ids.add(id);
    }
  }

  return [...ids];
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

function extractUserName(record: Record<string, unknown>) {
  return (
    asText(record.name) ||
    asText(record.full_name) ||
    asText(record.display_name) ||
    [asText(record.first_name), asText(record.last_name)].filter(Boolean).join(" ") ||
    asText((record.contact_info as Record<string, unknown>)?.name) ||
    "Unnamed user"
  );
}

export async function fetchDestinationUsers(
  apiKey: string
): Promise<DestinationUserOption[]> {
  const fetchUserPages = async (endpointBase: string) => {
    const users: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({
        page_size: "200",
        include_disabled: "true",
      });
      if (cursor) params.set("cursor", cursor);
      const response = await proxyCallWithRetry<Record<string, unknown>>(
        apiKey,
        `${endpointBase}?${params.toString()}`
      );
      const page =
        (Array.isArray(response.data) && response.data) ||
        (Array.isArray(response.users) && response.users) ||
        (Array.isArray(response.items) && response.items) ||
        (Array.isArray(response.results) && response.results) ||
        [];
      users.push(...(page as Record<string, unknown>[]));
      cursor = asText(response.next_cursor);
    } while (cursor);
    return users;
  };

  let users = await fetchUserPages("/lifecycle-manager/v1/users");
  if (users.length === 0) {
    // Some accounts expose the same selectable people through the account-team
    // contract. Keep this as a read-only fallback for older tenant payloads.
    users = await fetchUserPages("/lifecycle-manager/v1/account-team/members");
  }

  return users
    .map((rawUser) => {
      const user =
        (isRecord(rawUser.user) && rawUser.user) ||
        (isRecord(rawUser.member) && rawUser.member) ||
        rawUser;
      const id =
        asText(user.id) ||
        asText(rawUser.user_id) ||
        asText(rawUser.account_user_id) ||
        asText(rawUser.member_id);
      const email =
        asText(user.email) ||
        asText((user.contact_info as Record<string, unknown>)?.email) ||
        asText(rawUser.email);
      if (!id) return null;
      return { id, email: email?.toLowerCase() || null, name: extractUserName(user) };
    })
    .filter((user): user is DestinationUserOption => Boolean(user))
    .filter((user, index, all) => all.findIndex((candidate) => candidate.id === user.id) === index)
    .sort((a, b) => `${a.name} ${a.email || ""}`.localeCompare(`${b.name} ${b.email || ""}`));
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

export function buildContractCreatePayload(record: Record<string, any>) {
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

function normalizeDeliverableStatus(value: unknown): "Draft" | "Published" | null {
  const status = asText(value);
  if (status === "Draft" || status === "Published") {
    return status;
  }
  return null;
}

async function resolveListedDeliverableId(
  apiKey: string,
  clientId: string,
  createdId: string,
  deliverableName: string
): Promise<string> {
  const response = await proxyCallWithRetry<{
    data?: Record<string, unknown>[];
  }>(
    apiKey,
    `/lifecycle-manager/v1/clients/${encodeURIComponent(clientId)}/deliverables`
  );

  const deliverables = Array.isArray(response.data) ? response.data : [];

  const byId = deliverables.find((item) => asText(item.id) === createdId);
  if (byId && asText(byId.id)) {
    return asText(byId.id)!;
  }

  const byName = deliverables.find((item) => asText(item.name) === deliverableName);
  if (byName && asText(byName.id)) {
    return asText(byName.id)!;
  }

  throw new Error(
    `Created deliverable '${deliverableName}' could not be resolved from the destination client deliverables list.`
  );
}

async function waitForDeliverableSnapshots(
  apiKey: string,
  deliverableId: string,
  maxAttempts = 12,
  delayMs = 1000
): Promise<{ ready: boolean; detail?: string }> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await proxyCallWithRetry<Record<string, any>>(
      apiKey,
      `/lifecycle-manager/v1/deliverables/${deliverableId}`
    );
    const deliverable =
      isRecord(response.deliverable) && response.deliverable
        ? response.deliverable
        : response;
    const components = Array.isArray(deliverable.sections)
      ? deliverable.sections.flatMap((section: any) =>
          Array.isArray(section?.components) ? section.components : []
        )
      : [];
    const failed = components.find((component: any) =>
      [component?.snapshot_status, component?.status].some(
        (status) => typeof status === "string" && /failed|error/i.test(status)
      )
    );
    if (failed) {
      return {
        ready: false,
        detail: "A deliverable component snapshot failed before publishing.",
      };
    }
    const pending = components.some((component: any) =>
      [component?.snapshot_status, component?.status].some(
        (status) => typeof status === "string" && /inprogress|pending|processing/i.test(status)
      )
    );
    if (!pending) return { ready: true };
    if (attempt < maxAttempts - 1) await sleep(delayMs);
  }
  return {
    ready: false,
    detail: "Timed out waiting for deliverable component snapshots to settle.",
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

async function fetchActionItemsViaRelationships(
  apiKey: string,
  client: MigrationClient
): Promise<Record<string, any>[]> {
  const actionItemIds = new Set<string>();
  const diagnostics: string[] = [];

  let initiatives: Record<string, any>[] = [];
  try {
    initiatives = await fetchAllPages<Record<string, any>>(
      apiKey,
      (cursor) => {
        const params = new URLSearchParams({
          "filter[client.id]": client.id,
          page_size: "100",
        });
        if (cursor) params.set("cursor", cursor);
        return `/lifecycle-manager/v1/initiatives?${params.toString()}`;
      }
    );
  } catch (error) {
    diagnostics.push(
      `Initiatives list fallback failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
    initiatives = [];
  }

  for (const initiative of initiatives) {
    const initiativeId = asText(initiative.id);
    if (!initiativeId) continue;
    let ids: string[] = [];
    try {
      ids = await fetchRelationshipIdList(
        apiKey,
        `/lifecycle-manager/v1/initiatives/${initiativeId}/action-items`,
        "action_item_ids"
      );
    } catch (error) {
      diagnostics.push(
        `Initiative ${initiativeId} action-items link fetch failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
      ids = [];
    }
    ids.forEach((id) => actionItemIds.add(id));
  }

  let meetings: Record<string, any>[] = [];
  try {
    meetings = await fetchAllPages<Record<string, any>>(
      apiKey,
      (cursor) => {
        const params = new URLSearchParams({
          "filter[client.id]": client.id,
          page_size: "100",
        });
        if (cursor) params.set("cursor", cursor);
        return `/lifecycle-manager/v1/meetings?${params.toString()}`;
      }
    );
  } catch (error) {
    diagnostics.push(
      `Meetings list fallback failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
    meetings = [];
  }

  for (const meeting of meetings) {
    const meetingId = asText(meeting.id);
    if (!meetingId) continue;
    let ids: string[] = [];
    try {
      ids = await fetchRelationshipIdList(
        apiKey,
        `/lifecycle-manager/v1/meetings/${meetingId}/action-items`,
        "action_item_ids"
      );
    } catch (error) {
      diagnostics.push(
        `Meeting ${meetingId} action-items link fetch failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
      ids = [];
    }
    ids.forEach((id) => actionItemIds.add(id));
  }

  const records: Record<string, any>[] = [];
  for (const actionItemId of actionItemIds) {
    await sleep(DEFAULT_DELAY_MS);
    try {
      const detailResponse = await proxyCallWithRetry<Record<string, any>>(
        apiKey,
        `/lifecycle-manager/v1/action-items/${actionItemId}`
      );
      const detailRecord =
        (isRecord(detailResponse.action_item) && detailResponse.action_item) ||
        detailResponse;
      records.push(detailRecord);
    } catch (error) {
      diagnostics.push(
        `Action item detail ${actionItemId} fetch failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
      continue;
    }
  }

  if (records.length === 0 && diagnostics.length > 0) {
    throw new Error(
      `Action item fallback produced no records. ${diagnostics.join(" | ")}`
    );
  }

  return records;
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

    let initiativeIds: string[] = [];
    try {
      initiativeIds = await fetchRelationshipIdList(
        sourceApiKey,
        `/lifecycle-manager/v1/goals/${goalId}/initiatives`,
        "initiative_ids"
      );
    } catch {
      // Relationship endpoints are optional for migration. A missing or
      // permission-gated link must not block the records themselves.
    }
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

    let meetingIds: string[] = [];
    try {
      meetingIds = await fetchRelationshipIdList(
        sourceApiKey,
        `/lifecycle-manager/v1/goals/${goalId}/meetings`,
        "meeting_ids"
      );
    } catch {
      // See the initiative relationship note above.
    }
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

    let actionItemIds: string[] = [];
    try {
      actionItemIds = await fetchRelationshipIdList(
        sourceApiKey,
        `/lifecycle-manager/v1/initiatives/${initiativeId}/action-items`,
        "action_item_ids"
      );
    } catch {
      // See the initiative relationship note above.
    }
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

    let initiativeIds: string[] = [];
    try {
      initiativeIds = await fetchRelationshipIdList(
        sourceApiKey,
        `/lifecycle-manager/v1/meetings/${meetingId}/initiatives`,
        "initiative_ids"
      );
    } catch {
      // See the initiative relationship note above.
    }
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

    let actionItemIds: string[] = [];
    try {
      actionItemIds = await fetchRelationshipIdList(
        sourceApiKey,
        `/lifecycle-manager/v1/meetings/${meetingId}/action-items`,
        "action_item_ids"
      );
    } catch {
      // See the initiative relationship note above.
    }
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
        type: "Agenda / Notes",
        sourceRecord: meetingName,
        targetRecord: "Agenda",
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

function buildEqFilterValue(value: string) {
  const normalizedValue = value.trim();
  return /[\s,"]/.test(normalizedValue)
    ? `eq:"${normalizedValue.replace(/"/g, '\\"')}"`
    : `eq:${normalizedValue}`;
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
      const email = asText((member.contact_info as Record<string, unknown>)?.email) || asText(member.email);
      if (id && email) {
        results.push({ id, email: email.toLowerCase() });
      }
    }

    cursor = response.next_cursor || null;
  } while (cursor);

  return results;
}

function findMemberEmailById(
  members: Array<{ id: string; email: string }>,
  id: string | null | undefined
) {
  const normalizedId = id?.trim();
  if (!normalizedId) return null;
  return members.find((member) => member.id === normalizedId)?.email || null;
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
        asText((member.contact_info as Record<string, unknown>)?.email) || asText(member.email);
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

function extractDestinationContact(
  contact: Record<string, unknown>
): DestinationContact | null {
  const id = asText(contact.id);
  if (!id) return null;

  const clientRecord = isRecord(contact.client) ? contact.client : null;
  return {
    id,
    email:
      asText((contact.contact_info as Record<string, unknown>)?.email) ||
      asText(contact.email) ||
      null,
    clientId: asText(clientRecord?.id) || null,
    clientName: asText(clientRecord?.name) || asText(clientRecord?.label) || null,
    label: asText(contact.label) || asText(contact.name) || null,
  };
}

async function lookupDestinationContactsByEmail(
  apiKey: string,
  destinationClient: MigrationClient,
  email: string,
  cache?: Map<string, DestinationContact[]>
): Promise<DestinationContact[]> {
  const normalizedEmail = email.trim().toLowerCase();
  const cacheKey = `${destinationClient.id}:${normalizedEmail}`;
  const cached = cache?.get(cacheKey);
  if (cached) return cached;
  const filtersByPriority: Array<Record<string, string>> = [
    {
      "contact_info.email": buildMemberEmailFilterValue(normalizedEmail),
      "client.id": buildEqFilterValue(destinationClient.id),
    },
    {
      "contact_info.email": buildMemberEmailFilterValue(normalizedEmail),
      "client.name": buildEqFilterValue(destinationClient.name),
    },
    {
      "contact_info.email": buildMemberEmailFilterValue(normalizedEmail),
    },
  ];

  for (const filter of filtersByPriority) {
    const response = await proxyCallWithRetry<{
      data?: Record<string, unknown>[];
    }>(apiKey, "/core/v1/contacts", "POST", { filter });

    const matches = (response.data || [])
      .map(extractDestinationContact)
      .filter((contact): contact is DestinationContact => Boolean(contact))
      .filter(
        (contact) =>
          contact.email?.trim().toLowerCase() === normalizedEmail
      );

    if (matches.length === 1) {
      cache?.set(cacheKey, matches);
      return matches;
    }

    if (matches.length > 1) {
      const exactClientIdMatches = matches.filter(
        (contact) => contact.clientId === destinationClient.id
      );
      if (exactClientIdMatches.length === 1) {
        cache?.set(cacheKey, exactClientIdMatches);
        return exactClientIdMatches;
      }

      const exactClientNameMatches = matches.filter(
        (contact) =>
          normalizeName(contact.clientName || "") ===
          normalizeName(destinationClient.name)
      );
      if (exactClientNameMatches.length === 1) {
        cache?.set(cacheKey, exactClientNameMatches);
        return exactClientNameMatches;
      }

      cache?.set(cacheKey, matches);
      return matches;
    }
  }

  cache?.set(cacheKey, []);
  return [];
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

export function buildTagCreatePayload(sourceTag: Record<string, any>) {
  return {
    tag: {
      name: asText(sourceTag.name) || "Untitled tag",
      ...(asText(sourceTag.domain)
        ? { domain: sourceTag.domain }
        : {}),
      ...(sourceTag.color !== undefined ? { color: sourceTag.color } : {}),
    },
  };
}

async function fetchTags(apiKey: string): Promise<Record<string, any>[]> {
  const response = await proxyCallWithRetry<{
    data?: Record<string, any>[];
  }>(apiKey, "/lifecycle-manager/v1/tags");
  return Array.isArray(response.data) ? response.data : [];
}

async function migrateTags(
  sourceApiKey: string,
  destinationApiKey: string
): Promise<{ created: number; failures: MigrationErrorEntry[] }> {
  const sourceTags = await fetchTags(sourceApiKey);
  const destinationTags = await fetchTags(destinationApiKey);
  const keyFor = (tag: Record<string, any>) =>
    `${(asText(tag.name) || "").toLowerCase()}::${(
      asText(tag.domain) || ""
    ).toLowerCase()}`;
  const destinationKeys = new Set(destinationTags.map(keyFor));
  const failures: MigrationErrorEntry[] = [];
  let created = 0;

  for (const tag of sourceTags) {
    const key = keyFor(tag);
    if (!key.startsWith("::") && destinationKeys.has(key)) continue;
    try {
      await proxyCallWithRetry(
        destinationApiKey,
        "/lifecycle-manager/v1/tags",
        "POST",
        buildTagCreatePayload(tag)
      );
      destinationKeys.add(key);
      created += 1;
    } catch (error) {
      failures.push({
        clientName: "Account",
        objectType: "Tags",
        recordName: asText(tag.name) || "Untitled tag",
        errorCode: "TAG_CREATE_FAILED",
        errorDetail: error instanceof Error ? error.message : "Unknown error",
        endpoint: "/lifecycle-manager/v1/tags",
        method: "POST",
        requestPayload: buildTagCreatePayload(tag),
      });
    }
  }

  return { created, failures };
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

async function fetchAssessmentTemplateDetail(
  apiKey: string,
  templateId: string
): Promise<AssessmentTemplateDetail> {
  const response = await proxyCallWithRetry<Record<string, any>>(
    apiKey,
    `/lifecycle-manager/v1/assessment-templates/${encodeURIComponent(templateId)}`
  );
  const template = isRecord(response.assessment_template)
    ? response.assessment_template
    : response;
  const id = asText(template.assessment_template_id) || templateId;
  const title = asText(template.title) || "Untitled assessment template";
  return { id, title, template };
}

/**
 * Build the cross-tenant create body. Assessment template IDs are tenant
 * scoped, so copying them would make the destination reject the request.
 */
export function buildAssessmentTemplateCreatePayload(
  sourceTemplate: Record<string, any>
) {
  const categories = Array.isArray(sourceTemplate.categories)
    ? sourceTemplate.categories
    : [];

  return {
    assessment_template: {
      ...(asText(sourceTemplate.scope)
        ? { scope: sourceTemplate.scope }
        : {}),
      title: asText(sourceTemplate.title) || "Untitled assessment template",
      ...(sourceTemplate.description !== undefined
        ? { description: sourceTemplate.description }
        : {}),
      ...(sourceTemplate.is_category_weight_evenly_distributed !== undefined
        ? {
            is_category_weight_evenly_distributed:
              sourceTemplate.is_category_weight_evenly_distributed,
          }
        : {}),
      categories: categories.map((category: Record<string, any>) => ({
        title: asText(category.title) || "Untitled category",
        ...(category.description !== undefined
          ? { description: category.description }
          : {}),
        ...(category.is_question_weight_evenly_distributed !== undefined
          ? {
              is_question_weight_evenly_distributed:
                category.is_question_weight_evenly_distributed,
            }
          : {}),
        ...(category.weight_in_percentage !== undefined
          ? { weight_in_percentage: category.weight_in_percentage }
          : {}),
        questions: (Array.isArray(category.questions)
          ? category.questions
          : []
        ).map((question: Record<string, any>) => ({
          title: asText(question.title) || "Untitled question",
          ...(question.description !== undefined
            ? { description: question.description }
            : {}),
          ...(question.remediation_tips !== undefined
            ? { remediation_tips: question.remediation_tips }
            : {}),
          ...(question.scoring_instructions !== undefined
            ? { scoring_instructions: question.scoring_instructions }
            : {}),
          ...(question.criterion_label_type_enum !== undefined
            ? { criterion_label_type_enum: question.criterion_label_type_enum }
            : {}),
          ...(question.weight_in_percentage !== undefined
            ? { weight_in_percentage: question.weight_in_percentage }
            : {}),
          // The source response does not reliably expose tag IDs. An empty
          // array is valid and avoids leaking IDs from the source tenant.
          tag_ids: [],
          criteria: (Array.isArray(question.criteria)
            ? question.criteria
            : []
          ).map((criterion: Record<string, any>) => ({
            ...(criterion.label_enum !== undefined
              ? { label_enum: criterion.label_enum }
              : {}),
            ...(criterion.description !== undefined
              ? { description: criterion.description }
              : {}),
          })),
        })),
      })),
    },
  };
}

async function provisionMissingAssessmentTemplates(
  sourceApiKey: string,
  destinationApiKey: string,
  sourceTemplates: AssessmentTemplateOverview[],
  destinationTemplates: AssessmentTemplateOverview[]
): Promise<AssessmentTemplateOverview[]> {
  const destinationByTitle = new Map(
    destinationTemplates.map((template) => [
      normalizeTemplateTitle(template.title),
      template,
    ])
  );
  const result = [...destinationTemplates];

  for (const sourceTemplate of sourceTemplates) {
    const key = normalizeTemplateTitle(sourceTemplate.title);
    if (!key || destinationByTitle.has(key)) continue;

    const detail = await fetchAssessmentTemplateDetail(
      sourceApiKey,
      sourceTemplate.id
    );
    const created = await proxyCall<Record<string, any>>(
      destinationApiKey,
      "/lifecycle-manager/v1/assessment-templates",
      "POST",
      buildAssessmentTemplateCreatePayload(detail.template)
    );
    const createdTemplate = isRecord(created.assessment_template)
      ? created.assessment_template
      : created;
    const createdId =
      asText(createdTemplate.assessment_template_id) ||
      asText(createdTemplate.id);

    if (!createdId) {
      throw new Error(
        `Assessment template "${sourceTemplate.title}" was created but the API did not return its destination ID.`
      );
    }

    const provisioned = { id: createdId, title: sourceTemplate.title };
    destinationByTitle.set(key, provisioned);
    result.push(provisioned);
  }

  return result;
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
): { configuration: unknown; skippedReason?: string } {
  if (configuration === undefined) {
    return { configuration };
  }

  const clonedConfiguration = cloneJsonValue(configuration);
  if (componentKey.toLowerCase().includes("custom")) {
    if (!isRecord(clonedConfiguration) || !isRecord(clonedConfiguration.data)) {
      return {
        configuration: clonedConfiguration,
        skippedReason: "Custom component configuration is missing its data object.",
      };
    }
    const data = clonedConfiguration.data;
    const content = isRecord(data.content) ? data.content : null;
    if (content) {
      const contentJson = content.content_json;
      data.content = {
        ...content,
        type: "RichText",
        ...(typeof contentJson === "string"
          ? { content_json: contentJson }
          : { content_json: JSON.stringify(contentJson || { type: "doc", content: [] }) }),
      };
    } else if (data.content_json !== undefined) {
      data.content = {
        type: "RichText",
        content_json:
          typeof data.content_json === "string"
            ? data.content_json
            : JSON.stringify(data.content_json),
      };
      delete data.content_json;
    } else {
      return {
        configuration: clonedConfiguration,
        skippedReason: "Custom component configuration has no supported RichText content.",
      };
    }
    return { configuration: clonedConfiguration };
  }

  if (componentKey !== "Assessments") {
    return { configuration: clonedConfiguration };
  }

  if (!isRecord(clonedConfiguration) || !isRecord(clonedConfiguration.data)) {
    return { configuration: clonedConfiguration };
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
      return {
        configuration: clonedConfiguration,
        skippedReason: `Assessments component skipped - source assessment template ${sourceTemplateId} could not be resolved.`,
      };
    }

    const destinationTemplateId =
      destinationAssessmentTemplateIdsByTitle.get(
        normalizeTemplateTitle(sourceTemplateTitle) || ""
      ) || null;

    if (!destinationTemplateId) {
      return {
        configuration: clonedConfiguration,
        skippedReason: `Assessments component skipped - destination assessment template '${sourceTemplateTitle}' could not be resolved.`,
      };
    }

    report.assessment_template_id = destinationTemplateId;
  }

  return { configuration: clonedConfiguration };
}

function buildDeliverableCreatePayload(
  clientName: string,
  record: Record<string, any>,
  sourceAssessmentTemplateTitlesById: Map<string, string>,
  destinationAssessmentTemplateIdsByTitle: Map<string, string>
) {
  const sourceSections = Array.isArray(record.sections) ? record.sections : [];
  const warnings: MigrationErrorEntry[] = [];

  const payload = {
    name: asText(record.name) || asText(record.title) || "Migrated Deliverable",
    sections: sourceSections
      .map((section, sectionIndex) => {
      const sourceComponents = Array.isArray(section?.components)
        ? section.components
        : [];

      const components = sourceComponents
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

          let configuration: unknown = undefined;
          if (component?.configuration !== undefined) {
            const remappedComponent = remapDeliverableComponentConfiguration(
              componentKey,
              component.configuration,
              sourceAssessmentTemplateTitlesById,
              destinationAssessmentTemplateIdsByTitle
            );

            if (remappedComponent.skippedReason) {
              warnings.push(
                buildWarning(
                  clientName,
                  OBJECT_LABELS.deliverables,
                  getRecordName(record, "Migrated Deliverable"),
                  remappedComponent.skippedReason
                )
              );
              return null;
            }

            configuration = remappedComponent.configuration;
          }

          return {
            component_key: componentKey,
            component_type_configuration: componentTypeConfiguration,
            ...(configuration !== undefined ? { configuration } : {}),
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
        );

      if (components.length === 0) {
        return null;
      }

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
        components,
      };
    })
      .filter((section): section is NonNullable<typeof section> => Boolean(section)),
  };

  return { payload, warnings };
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

  let list: Record<string, any>[] = [];
  try {
    list = await fetchAllPages<Record<string, any>>(
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
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (type !== "actionItems" || !/\b5\d{2}\b/.test(detail)) {
      throw error;
    }
    try {
      return await fetchActionItemsViaRelationships(apiKey, client);
    } catch (fallbackError) {
      const listError = error instanceof Error ? error.message : "Unknown error";
      const fallbackDetail =
        fallbackError instanceof Error ? fallbackError.message : "Unknown fallback error";
      throw new Error(
        `Primary action-items list failed: ${listError}. Relationship fallback also failed: ${fallbackDetail}`
      );
    }
  }

  if (
    type !== "assessments" &&
    type !== "meetings" &&
    type !== "contracts"
  ) {
    return list;
  }

  const detailed: Record<string, any>[] = [];
  for (const item of list) {
    await sleep(DEFAULT_DELAY_MS);
    const detailResponse = await proxyCallWithRetry<Record<string, any>>(
      apiKey,
      `${endpointBase}/${item.id}${type === "assessments" ? "?include=children" : ""}`
    );
    const detailRecord =
      (type === "meetings" &&
        isRecord(detailResponse.meeting) &&
        detailResponse.meeting) ||
      (type === "contracts" &&
        isRecord(detailResponse.contract) &&
        detailResponse.contract) ||
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
  primaryDestinationUserId: string | null = null,
  sourceMembers: SourceMember[] = [],
  destinationMembers: DestinationMember[] = [],
  destinationMeetingTypes: DestinationMeetingType[] = [],
  destinationContactCache: Map<string, DestinationContact[]> = new Map(),
  deliverableClientIdCache: Map<string, string> = new Map(),
  sourceAssessmentTemplateTitlesById: Map<string, string> = new Map(),
  destinationAssessmentTemplateIdsByTitle: Map<string, string> = new Map(),
  sameTenantClone = false
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

    const updateInitiativeComponent = async (
      component: string,
      endpoint: string,
      body: ApiBody
    ) => {
      try {
        await sleep(DEFAULT_DELAY_MS);
        await proxyCallWithRetry(destinationApiKey, endpoint, "PUT", body);
      } catch (error) {
        warnings.push(
          buildWarning(
            destinationClient.name,
            OBJECT_LABELS.initiatives,
            recordName,
            `${component} could not be copied: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          )
        );
      }
    };

    if (asText(record.status)) {
      await updateInitiativeComponent(
        "Status",
        `/lifecycle-manager/v1/initiatives/${created.id}/status`,
        { status: asText(record.status) }
      );
    }
    if (asText(record.priority)) {
      await updateInitiativeComponent(
        "Priority",
        `/lifecycle-manager/v1/initiatives/${created.id}/priority`,
        { priority: asText(record.priority) }
      );
    }
    if (record.fiscal_quarter != null) {
      const fiscalQuarter = normalizeInitiativeFiscalQuarter(record.fiscal_quarter);
      if (!fiscalQuarter) {
        warnings.push(
          buildWarning(
            destinationClient.name,
            OBJECT_LABELS.initiatives,
            recordName,
            "Schedule was not copied because the source fiscal quarter had an invalid shape."
          )
        );
      }
      if (fiscalQuarter) {
      await updateInitiativeComponent(
        "Schedule",
        `/lifecycle-manager/v1/initiatives/${created.id}/schedule`,
        { fiscal_quarter: fiscalQuarter }
      );
      }
    }
    const budgetLineItems = Array.isArray(record.budget?.line_items)
      ? record.budget.line_items
      : [];
    if (budgetLineItems.length > 0) {
      await updateInitiativeComponent(
        "Budget",
        `/lifecycle-manager/v1/initiatives/${created.id}/budget`,
        { budget_line_items: budgetLineItems }
      );
    }
    const recurringLineItems = Array.isArray(record.budget?.recurring_line_items)
      ? record.budget.recurring_line_items
      : [];
    if (recurringLineItems.length > 0) {
      await updateInitiativeComponent(
        "Recurring budget",
        `/lifecycle-manager/v1/initiatives/${created.id}/recurring`,
        { recurring_line_items: recurringLineItems }
      );
    }

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
      "PATCH",
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
    const sourceAssigneeIds = extractActionItemAssigneeIds(record);
    const completionStatus = asText(record.completion_status) || "";
    const sourceAssigneeEmails = [
      ...new Set(
        [
          ...extractActionItemAssigneeEmails(record),
          ...sourceAssigneeIds
            .map((sourceId) => findMemberEmailById(sourceMembers, sourceId))
            .filter((value): value is string => Boolean(value)),
        ].map((email) => email.trim().toLowerCase())
      ),
    ];
    const fallbackAssigneeUserId = primaryDestinationUserId?.trim() || null;

    if (
      sourceAssigneeIds.length === 0 &&
      sourceAssigneeEmails.length === 0 &&
      !fallbackAssigneeUserId
    ) {
      throw new Error("Skipped - no assignee available.");
    }

    const assignedUserIdsPayload =
      sourceAssigneeEmails.length > 0
        ? sourceAssigneeEmails.map((email) => ({ email }))
        : fallbackAssigneeUserId
        ? [fallbackAssigneeUserId]
        : sourceAssigneeIds.length > 0
        ? sourceAssigneeIds
        : [];

    if (assignedUserIdsPayload.length === 0) {
      throw new Error("Skipped - assignees could not be resolved for creation.");
    }

    const actionItemTitle =
      asText(record.title) ||
      asText(record.name) ||
      asText(record.subject) ||
      asText(record.description) ||
      "Migrated action item";
    const actionItemDescription =
      asText(record.description) || actionItemTitle;

    const body = {
      client_key: { id: destinationClientId },
      title: actionItemTitle,
      description_json:
        asText(record.description_json) ||
        buildProseMirrorJson(actionItemDescription),
      assigned_user_ids: assignedUserIdsPayload,
      due_at: normalizeDueAt(record.due_at),
    };

    const created = await proxyCallWithRetry<{ id: string }>(
      destinationApiKey,
      "/lifecycle-manager/v1/action-items",
      "POST",
      body
    );

    if (
      record.is_completed === true ||
      Boolean(record.completed_at) ||
      completionStatus.length > 0
    ) {
      await sleep(DEFAULT_DELAY_MS);
      await proxyCallWithRetry(
        destinationApiKey,
        `/lifecycle-manager/v1/action-items/${created.id}/completion-status`,
        "PUT",
        {
          is_completed:
            record.is_completed === true ||
            Boolean(record.completed_at) ||
            completionStatus.toLowerCase() === "completed",
        }
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
        resolvedEmail:
          sourceAssigneeEmails[0] || null,
        resolvedUserId: fallbackAssigneeUserId,
        sourceUserId: sourceAssigneeIds[0] || null,
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
    const preferredEvaluatorEmail = extractAssessmentEvaluatorEmail(record);
    const sourceEvaluateUserId = asText(record.evaluate_user_id) || null;
    const evaluatorUserId = primaryDestinationUserId;

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
      error.sourceUserId = sourceEvaluateUserId;
      throw error;
    }

    const sourceTemplateTitle = templateId
      ? sourceAssessmentTemplateTitlesById.get(templateId) || null
      : null;
    const destinationTemplateId = sourceTemplateTitle
      ? destinationAssessmentTemplateIdsByTitle.get(
          normalizeTemplateTitle(sourceTemplateTitle)
        ) || null
      : sameTenantClone
      ? templateId
      : null;

    if (!destinationTemplateId) {
      throw new Error(
        `Skipped - assessment template '${sourceTemplateTitle || templateId}' could not be matched in the destination tenant.`
      );
    }

    const body = {
      client_key: { id: destinationClientId },
      title: asText(record.title) || "Migrated Assessment",
      assessment_template_id: destinationTemplateId,
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

    // Replay answers from the source assessment by mapping
    // assessment_template_question_id -> destination question id, and
    // assessment_template_criterion_id -> destination criterion id.
    let answersReplayed = 0;
    let answersUnmapped = 0;
    let replayErrorMessage: string | null = null;
    try {
      const sourceQuestionEvaluations: {
        templateQuestionId: string;
        templateCriterionId: string;
      }[] = [];

      const sourceCategories = Array.isArray(record.category_list)
        ? record.category_list
        : [];
      for (const category of sourceCategories) {
        if (!isRecord(category)) continue;
        const questions = Array.isArray(category.question_list)
          ? category.question_list
          : [];
        for (const question of questions) {
          if (!isRecord(question)) continue;
          const templateQuestionId = asText(
            question.assessment_template_question_id
          );
          if (!templateQuestionId) continue;
          const criteria = Array.isArray(question.criteria_list)
            ? question.criteria_list
            : [];
          const selected = criteria.find(
            (c) => isRecord(c) && c.is_selected === true
          );
          if (!selected || !isRecord(selected)) continue;
          const templateCriterionId = asText(
            selected.assessment_template_criterion_id
          );
          if (!templateCriterionId) continue;
          sourceQuestionEvaluations.push({
            templateQuestionId,
            templateCriterionId,
          });
        }
      }

      if (sourceQuestionEvaluations.length > 0) {
        await sleep(DEFAULT_DELAY_MS);
        const destinationDetail = await proxyCallWithRetry<Record<string, any>>(
          destinationApiKey,
          `/lifecycle-manager/v1/assessments/${created.id}`
        );
        const destinationAssessment =
          (isRecord(destinationDetail.assessment) &&
            destinationDetail.assessment) ||
          destinationDetail;

        const destQuestionByTemplateId = new Map<string, string>();
        const destCriterionByTemplateId = new Map<string, Map<string, string>>();

        const destCategories = Array.isArray(destinationAssessment.category_list)
          ? destinationAssessment.category_list
          : [];
        for (const category of destCategories) {
          if (!isRecord(category)) continue;
          const questions = Array.isArray(category.question_list)
            ? category.question_list
            : [];
          for (const question of questions) {
            if (!isRecord(question)) continue;
            const tplQId = asText(question.assessment_template_question_id);
            const qId = asText(question.assessment_question_id);
            if (!tplQId || !qId) continue;
            destQuestionByTemplateId.set(tplQId, qId);

            const criteriaMap = new Map<string, string>();
            const criteria = Array.isArray(question.criteria_list)
              ? question.criteria_list
              : [];
            for (const criterion of criteria) {
              if (!isRecord(criterion)) continue;
              const tplCId = asText(criterion.assessment_template_criterion_id);
              const cId = asText(criterion.assessment_criterion_id);
              if (!tplCId || !cId) continue;
              criteriaMap.set(tplCId, cId);
            }
            destCriterionByTemplateId.set(tplQId, criteriaMap);
          }
        }

        const questionEvaluations: {
          question_id: string;
          selected_criteria_id: string;
        }[] = [];
        for (const entry of sourceQuestionEvaluations) {
          const destQuestionId = destQuestionByTemplateId.get(
            entry.templateQuestionId
          );
          const criteriaMap = destCriterionByTemplateId.get(
            entry.templateQuestionId
          );
          const destCriterionId = criteriaMap?.get(entry.templateCriterionId);
          if (destQuestionId && destCriterionId) {
            questionEvaluations.push({
              question_id: destQuestionId,
              selected_criteria_id: destCriterionId,
            });
          } else {
            answersUnmapped += 1;
          }
        }

        if (questionEvaluations.length > 0) {
          await sleep(DEFAULT_DELAY_MS);
          await proxyCallWithRetry(
            destinationApiKey,
            `/lifecycle-manager/v1/assessments/${created.id}/evaluate`,
            "PUT",
            { question_evaluations: questionEvaluations }
          );
          answersReplayed = questionEvaluations.length;
        }
      }
    } catch (replayError) {
      replayErrorMessage =
        replayError instanceof Error
          ? replayError.message
          : "Unknown error replaying assessment answers.";
    }

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

    if (replayErrorMessage) {
      warnings.push(
        buildWarning(
          destinationClient.name,
          OBJECT_LABELS.assessments,
          recordName,
          `Assessment created but answer replay failed: ${replayErrorMessage}`
        )
      );
    } else if (answersReplayed === 0) {
      warnings.push(
        buildWarning(
          destinationClient.name,
          OBJECT_LABELS.assessments,
          recordName,
          "Assessment created. No selected answers were found on the source to replay."
        )
      );
    } else if (answersUnmapped > 0) {
      warnings.push(
        buildWarning(
          destinationClient.name,
          OBJECT_LABELS.assessments,
          recordName,
          `Assessment created and ${answersReplayed} answer(s) replayed. ${answersUnmapped} answer(s) could not be mapped to destination questions/criteria.`
        )
      );
    }

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

    let created: { id: string };
    let usedV1Fallback = false;
    try {
      created = await proxyCallWithRetry<{ id: string }>(
        destinationApiKey,
        "/lifecycle-manager/v2/meetings",
        "POST",
        body
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      if (!/\b5\d{2}\b/.test(detail)) {
        throw error;
      }

      usedV1Fallback = true;
      created = await proxyCallWithRetry<{ id: string }>(
        destinationApiKey,
        "/lifecycle-manager/v1/meetings",
        "POST",
        {
          client_key: { id: destinationClientId },
          title: body.title,
          scheduled_at:
            (isIsoDateTime(record.scheduled_at) && record.scheduled_at) ||
            body.starts_at ||
            null,
        }
      );
    }

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

    if (usedV1Fallback) {
      warnings.push(
        buildWarning(
          destinationClient.name,
          OBJECT_LABELS.meetings,
          recordName,
          "Meeting created via the v1 fallback because the v2 meetings endpoint returned a server error."
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

    const sourceUserIds = extractIds(
      record.attendees?.users || record.attendee_users || record.users
    );
    const matchedUserIds: string[] = [];
    const directSourceUserIds: string[] = [];
    let unresolvedPlatformAttendees = 0;

    for (const sourceUserId of sourceUserIds) {
      const sourceEmail = findMemberEmailById(sourceMembers, sourceUserId);
      if (!sourceEmail) {
        if (sameTenantClone) {
          directSourceUserIds.push(sourceUserId);
          warnings.push(
            buildWarning(
              destinationClient.name,
              OBJECT_LABELS.meetings,
              recordName,
              `Platform attendee '${sourceUserId}' was attached using the raw source user id because this is a same-tenant clone and no source member email was found.`
            )
          );
          continue;
        }
        unresolvedPlatformAttendees += 1;
        warnings.push(
          buildWarning(
            destinationClient.name,
            OBJECT_LABELS.meetings,
            recordName,
            `Platform attendee '${sourceUserId}' could not be mapped because no source member email was found.`
          )
        );
        continue;
      }

      const destinationUserId =
        findDestinationMemberIdByEmail(destinationMembers, sourceEmail) ||
        (await findDestinationMemberIdByEmailViaApi(
          destinationApiKey,
          sourceEmail
        ));

      if (!destinationUserId) {
        if (sameTenantClone) {
          directSourceUserIds.push(sourceUserId);
          warnings.push(
            buildWarning(
              destinationClient.name,
              OBJECT_LABELS.meetings,
              recordName,
              `Platform attendee '${sourceEmail}' was attached using the raw source user id because this is a same-tenant clone and no destination user match was found.`
            )
          );
          continue;
        }
        unresolvedPlatformAttendees += 1;
        warnings.push(
          buildWarning(
            destinationClient.name,
            OBJECT_LABELS.meetings,
            recordName,
            `Platform attendee '${sourceEmail}' could not be matched to a destination platform user.`
          )
        );
        continue;
      }

      matchedUserIds.push(destinationUserId);
    }

    const attendeeUserIdsToAttach = [
      ...new Set([...matchedUserIds, ...directSourceUserIds]),
    ];

    if (attendeeUserIdsToAttach.length > 0) {
      await sleep(DEFAULT_DELAY_MS);
      await proxyCallWithRetry(
        destinationApiKey,
        `/lifecycle-manager/v1/meetings/${created.id}/attendees/users`,
        "POST",
        { user_ids: attendeeUserIdsToAttach }
      );
    }

    if (
      sourceUserIds.length > 0 ||
      matchedUserIds.length > 0 ||
      directSourceUserIds.length > 0 ||
      unresolvedPlatformAttendees > 0
    ) {
      warnings.push(
        buildWarning(
          destinationClient.name,
          OBJECT_LABELS.meetings,
          recordName,
          `Meeting platform attendees processed - mapped: ${matchedUserIds.length}, raw-id fallback: ${directSourceUserIds.length}, attached: ${attendeeUserIdsToAttach.length}, unresolved: ${unresolvedPlatformAttendees}.`
        )
      );
    }

    const sourceContactAttendees = Array.isArray(record.contact_attendees)
      ? record.contact_attendees
      : Array.isArray(record.attendees?.contacts)
      ? record.attendees.contacts
      : Array.isArray(record.attendee_contacts)
      ? record.attendee_contacts
      : Array.isArray(record.contacts)
      ? record.contacts
      : [];

    const matchedContactIds: string[] = [];
    let unresolvedCount = 0;
    let skippedDeletedCount = 0;

    for (const attendee of sourceContactAttendees) {
      if (!isRecord(attendee)) {
        unresolvedCount += 1;
        continue;
      }

      if (attendee.is_deleted === true) {
        skippedDeletedCount += 1;
        continue;
      }

      const attendeeLabel =
        asText(attendee.label) || asText(attendee.name) || "Meeting attendee";
      const attendeeEmail = asText(attendee.email);

      if (!attendeeEmail) {
        unresolvedCount += 1;
        warnings.push(
          buildWarning(
            destinationClient.name,
            OBJECT_LABELS.meetings,
            recordName,
            `Meeting attendee '${attendeeLabel}' could not be matched because no email was provided on the source meeting.`
          )
        );
        continue;
      }

      const matches = await lookupDestinationContactsByEmail(
        destinationApiKey,
        destinationClient,
        attendeeEmail,
        destinationContactCache
      );

      if (matches.length === 1) {
        matchedContactIds.push(matches[0].id);
        continue;
      }

      unresolvedCount += 1;
      warnings.push(
        buildWarning(
          destinationClient.name,
          OBJECT_LABELS.meetings,
          recordName,
          matches.length === 0
            ? `Meeting attendee '${attendeeEmail}' could not be matched to an existing destination contact.`
            : `Meeting attendee '${attendeeEmail}' matched multiple destination contacts and was not attached.`
        )
      );
    }

    if (matchedContactIds.length > 0) {
      await sleep(DEFAULT_DELAY_MS);
      await proxyCallWithRetry(
        destinationApiKey,
        `/lifecycle-manager/v1/meetings/${created.id}/attendees/contacts`,
        "POST",
        { contact_ids: [...new Set(matchedContactIds)] }
      );
    }

    if (
      sourceContactAttendees.length > 0 ||
      matchedContactIds.length > 0 ||
      unresolvedCount > 0 ||
      skippedDeletedCount > 0
    ) {
      warnings.push(
        buildWarning(
          destinationClient.name,
          OBJECT_LABELS.meetings,
          recordName,
          `Meeting client attendees processed - matched: ${matchedContactIds.length}, attached: ${[...new Set(matchedContactIds)].length}, unresolved: ${unresolvedCount}, skipped deleted: ${skippedDeletedCount}.`
        )
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
  const deliverablePayload = buildDeliverableCreatePayload(
    destinationClient.name,
    record,
    sourceAssessmentTemplateTitlesById,
    destinationAssessmentTemplateIdsByTitle
  );
  warnings.push(...deliverablePayload.warnings);
  const createBody = deliverablePayload.payload;
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

  const sourceDeliverableStatus = normalizeDeliverableStatus(record.status);
  if (sourceDeliverableStatus) {
    try {
      const snapshotResult = await waitForDeliverableSnapshots(
        destinationApiKey,
        createdId
      );
      if (!snapshotResult.ready) {
        throw new Error(snapshotResult.detail || "Deliverable snapshots did not settle.");
      }
      const listedDeliverableId = await resolveListedDeliverableId(
        destinationApiKey,
        deliverableClientId,
        createdId,
        getRecordName(record, "Migrated Deliverable")
      );
      await sleep(DEFAULT_DELAY_MS);
      await proxyCallWithRetry(
        destinationApiKey,
        `/lifecycle-manager/v1/deliverables/${listedDeliverableId}`,
        "PATCH",
        { status: sourceDeliverableStatus }
      );
    } catch (error) {
      warnings.push(
        buildWarning(
          destinationClient.name,
          OBJECT_LABELS.deliverables,
          getRecordName(record, "Migrated Deliverable"),
          `Deliverable created, but status could not be updated to ${sourceDeliverableStatus}.`
        )
      );
    }
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

  const processRelationship = async (item: PendingRelationship) => {
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
          return;
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
        return;
      } else if (item.type === "Agenda / Notes") {
        const meetingId = idMaps.meetings.get(item.sourceSourceId);
        log.push({
          clientName,
          type: item.type,
          sourceRecord: item.sourceRecord,
          targetRecord: item.targetRecord,
          status: meetingId ? "created" : "skipped",
          detail: meetingId ? undefined : "Linked destination record did not migrate",
        });
        return;
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
        return;
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
  };

  // Relationship writes are independent once record IDs are known. Keep a
  // small worker pool so large clients finish faster without bursting the API.
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < pendingRelationships.length) {
      const index = nextIndex;
      nextIndex += 1;
      await processRelationship(pendingRelationships[index]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(4, Math.max(1, pendingRelationships.length)) },
      () => worker()
    )
  );

  return log;
}

export async function runTenantMigration({
  sourceApiKey,
  destinationApiKey,
  mappings,
  selectedObjects,
  sourceClients,
  destinationClients,
  primaryDestinationUserId,
  onClientProgress,
}: RunMigrationParams): Promise<MigrationResult> {
  const clientSummaries: ClientSummary[] = [];
  const allErrors: MigrationErrorEntry[] = [];
  const relationshipLog: RelationshipLogEntry[] = [];
  const debugDiagnostics: MigrationDebugEntry[] = [];
  let totalCreated = 0;
  let totalFailures = 0;
  let destinationMembers: DestinationMember[] = [];
  let destinationUsers: DestinationUserOption[] = [];
  let sourceMembers: SourceMember[] = [];
  let destinationMeetingTypes: DestinationMeetingType[] = [];
  let sourceAssessmentTemplates: AssessmentTemplateOverview[] = [];
  let destinationAssessmentTemplates: AssessmentTemplateOverview[] = [];

  const sourceDeliverableClientIdCache = new Map<string, string>();
  const destinationDeliverableClientIdCache = new Map<string, string>();
  const destinationContactCache = new Map<string, DestinationContact[]>();
  const assessmentPreflightRecords = new Map<string, Record<string, any>[]>();
  const sameTenantClone = sourceApiKey.trim() === destinationApiKey.trim();
  const sourceClientLookup = new Map(
    sourceClients.map((client) => [client.id, client])
  );
  const destinationClientLookup = new Map(
    destinationClients.map((client) => [client.id, client])
  );

  if (selectedObjects.tags) {
    try {
      const tagResult = await migrateTags(sourceApiKey, destinationApiKey);
      totalCreated += tagResult.created;
      totalFailures += tagResult.failures.length;
      allErrors.push(...tagResult.failures);
    } catch (error) {
      totalFailures += 1;
      allErrors.push({
        clientName: "Account",
        objectType: "Tags",
        recordName: "Tag catalog",
        errorCode: "TAG_DISCOVERY_FAILED",
        errorDetail: error instanceof Error ? error.message : "Unknown error",
        endpoint: "/lifecycle-manager/v1/tags",
        method: "GET",
      });
    }
  }

  if (selectedObjects.assessments || selectedObjects.meetings) {
    try {
      destinationMembers = await fetchDestinationMembers(destinationApiKey);
    } catch {
      destinationMembers = [];
    }
  }

  if (selectedObjects.assessments || selectedObjects.actionItems) {
    destinationUsers = await fetchDestinationUsers(destinationApiKey);
    if (!primaryDestinationUserId) {
      throw new Error("Select a primary destination user before starting the migration.");
    }
    if (!destinationUsers.some((user) => user.id === primaryDestinationUserId)) {
      throw new Error("The selected primary destination user is no longer available. Refresh the user list and select another user.");
    }
  }

  if (selectedObjects.actionItems || selectedObjects.meetings) {
    try {
      sourceMembers = await fetchDestinationMembers(sourceApiKey);
    } catch {
      sourceMembers = [];
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

  if (selectedObjects.deliverables || selectedObjects.assessments) {
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

  if (selectedObjects.assessments || selectedObjects.deliverables) {
    destinationAssessmentTemplates = await provisionMissingAssessmentTemplates(
      sourceApiKey,
      destinationApiKey,
      sourceAssessmentTemplates,
      destinationAssessmentTemplates
    );
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

  if (selectedObjects.assessments) {
    for (const mapping of mappings) {
      const sourceClient = sourceClientLookup.get(mapping.srcClientId);
      if (!sourceClient) continue;
      const assessments = await fetchObjectRecords(
        sourceApiKey,
        "assessments",
        sourceClient,
        sourceDeliverableClientIdCache
      );
      assessmentPreflightRecords.set(sourceClient.id, assessments);
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
        records =
          type === "assessments" && assessmentPreflightRecords.has(sourceClient.id)
            ? assessmentPreflightRecords.get(sourceClient.id) || []
            : await fetchObjectRecords(
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
            primaryDestinationUserId,
            sourceMembers,
            destinationMembers,
            destinationMeetingTypes,
            destinationContactCache,
            destinationDeliverableClientIdCache,
            sourceAssessmentTemplateTitlesById,
            destinationAssessmentTemplateIdsByTitle,
            sameTenantClone
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
