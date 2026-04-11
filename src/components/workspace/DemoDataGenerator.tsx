import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { Lock, Loader2, PlugZap, TicketPlus, TriangleAlert } from "lucide-react";

interface Client {
  id: number | string;
  name: string;
}

interface HaloUser {
  id: number | string;
  name?: string;
  client_id?: number | string | null;
  site_id?: number | string | null;
}

interface TicketType {
  id: number | string;
  name?: string;
}

interface Category {
  id: number | string;
  name?: string;
}

interface Agent {
  id: number | string;
  name?: string;
}

interface Priority {
  id: number | string;
  name?: string;
}

interface Status {
  id: number | string;
  name?: string;
}

interface ExistingTicket extends Record<string, unknown> {}

interface GeneratedTicket {
  tickettype_id: number | string;
  summary: string;
  details: string;
  client_id: number | string;
  user_id: number | string;
  dateoccurred: string;
  agent_id?: number | string;
  priority_id?: number | string;
  status_id?: number | string;
  category_1?: number | string;
}

interface DemoDataGeneratorProps {
  triggerLabel?: string;
}

type PanelPhase = "idle" | "preview" | "generating" | "complete";

interface DiscoveryProbeAttempt {
  resource: string;
  url: string;
  topLevelKeys: string[];
  normalizedCount: number;
  arrayKeys: string[];
  error?: string | null;
}

interface DiscoveryProbeResult<T> {
  data: T[];
  warning: string | null;
  attempts: DiscoveryProbeAttempt[];
  matchedResource: string | null;
}

const RESOURCE_SERVER = "https://backupradar.halopsa.com/api";
const AUTH_SERVER = "https://backupradar.halopsa.com/auth";
const CLIENT_ID = "7505c3fd-1f69-44b4-97df-1e05424801c5";
const TENANT = "backupradar";
const TICKET_TEMPLATES = [
  {
    summary: "Laptop won't connect to VPN",
    details: "User reports VPN client fails to authenticate since yesterday morning.",
  },
  {
    summary: "Email not syncing on mobile",
    details: "Outlook app on iPhone stopped syncing. Last sync was 3 days ago.",
  },
  {
    summary: "Password reset request",
    details: "User locked out of their account after too many failed attempts.",
  },
  {
    summary: "Printer offline on 2nd floor",
    details: "HP LaserJet showing offline status. Other users on same floor also affected.",
  },
  {
    summary: "New employee onboarding — hardware request",
    details: "New hire starting Monday needs laptop, docking station, and access provisioned.",
  },
  {
    summary: "Software license needed — Adobe Acrobat",
    details: "User requires Adobe Acrobat Pro for contract review workflows.",
  },
  {
    summary: "Slow internet in meeting room B",
    details: "Teams calls dropping and videos buffering during back-to-back meetings.",
  },
  {
    summary: "Shared drive permissions issue",
    details: "User cannot access the Marketing shared folder after recent AD changes.",
  },
  {
    summary: "Antivirus alert on workstation",
    details: "Endpoint protection flagged a suspicious file in the Downloads folder.",
  },
  {
    summary: "Monitor flickering intermittently",
    details: "Second monitor connected via HDMI flickers every few minutes. Cables have been reseated.",
  },
] as const;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCollection<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data as T[];
    const numericKeys = Object.keys(record)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b));
    if (numericKeys.length > 0) {
      return numericKeys
        .map((key) => record[key] as T)
        .filter((item) => item !== undefined);
    }
    for (const key of Object.keys(record)) {
      if (key === "upstream_status" || key === "record_count" || key === "error") continue;
      if (Array.isArray(record[key])) return record[key] as T[];
    }
  }
  return [];
}

function describePayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { topLevelKeys: [] as string[], arrayKeys: [] as string[] };
  }

  const record = value as Record<string, unknown>;
  const topLevelKeys = Object.keys(record);
  const arrayKeys = topLevelKeys.filter((key) => Array.isArray(record[key]));
  return { topLevelKeys, arrayKeys };
}

function asScalarId(value: unknown): string | number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return null;
}

function asLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      asLabel(record.name) ||
      asLabel(record.label) ||
      asLabel(record.text) ||
      asLabel(record.value)
    );
  }
  return undefined;
}

function deriveOptions<T extends { id: string | number; name?: string }>(
  tickets: ExistingTicket[],
  specs: Array<{ idKeys: string[]; labelKeys: string[] }>
): T[] {
  const results = new Map<string, T>();

  for (const ticket of tickets) {
    for (const spec of specs) {
      const rawId = spec.idKeys.map((key) => ticket[key]).find((value) => asScalarId(value) !== null);
      const id = asScalarId(rawId);
      if (id === null) continue;

      const label = spec.labelKeys
        .map((key) => asLabel(ticket[key]))
        .find((value) => Boolean(value));

      const mapKey = String(id);
      if (!results.has(mapKey)) {
        results.set(mapKey, { id, ...(label ? { name: label } : {}) } as T);
      }
      break;
    }
  }

  return Array.from(results.values());
}

function formatError(status: number, payload: unknown) {
  if (typeof payload === "string" && payload.trim()) {
    return `${status} ${payload}`;
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const detail =
      (typeof record.error_description === "string" && record.error_description) ||
      (typeof record.message === "string" && record.message) ||
      (typeof record.error === "string" && record.error) ||
      (Array.isArray(record.errors) &&
        typeof record.errors[0] === "object" &&
        record.errors[0] &&
        typeof (record.errors[0] as Record<string, unknown>).detail === "string" &&
        ((record.errors[0] as Record<string, unknown>).detail as string)) ||
      Object.keys(record)
        .filter((key) => /^\d+$/.test(key))
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => record[key])
        .filter((value): value is string => typeof value === "string")
        .join("");

    if (detail) return `${status} ${detail}`;
  }

  return `${status} Request failed`;
}

async function proxyRequest<T = Record<string, unknown>>({
  url,
  method = "GET",
  body,
  headers,
}: {
  url: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<T> {
  const { data, error } = await supabase.functions.invoke("scalepad-proxy", {
    body: { url, method, body, headers },
  });

  if (error) {
    throw new Error(error.message || "Proxy request failed");
  }

  if (data?.error) {
    throw new Error(String(data.error));
  }

  if (typeof data?.upstream_status === "number" && data.upstream_status >= 400) {
    throw new Error(formatError(data.upstream_status, data));
  }

  return data as T;
}

function isoDateWithinLast90Days(index: number) {
  const now = new Date();
  const offsetDays = Math.floor(Math.random() * 90);
  now.setDate(now.getDate() - offsetDays);
  now.setHours(8 + (index % 9), (index * 7) % 60, 0, 0);
  return now.toISOString();
}

export default function DemoDataGenerator({
  triggerLabel = "Generate Demo Data",
}: DemoDataGeneratorProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [clientSecret, setClientSecret] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [panelPhase, setPanelPhase] = useState<PanelPhase>("idle");
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryWarnings, setDiscoveryWarnings] = useState<string[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [users, setUsers] = useState<HaloUser[]>([]);
  const [ticketTypes, setTicketTypes] = useState<TicketType[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [priorities, setPriorities] = useState<Priority[]>([]);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [ticketsCreated, setTicketsCreated] = useState(0);
  const [totalTickets, setTotalTickets] = useState(0);
  const [discoveryProbeLog, setDiscoveryProbeLog] = useState<
    Record<string, DiscoveryProbeAttempt[]>
  >({});

  const clientUserCounts = useMemo(
    () =>
      clients.map((client) => ({
        client,
        count: users.filter(
          (user) =>
            String(user.client_id ?? "") === String(client.id) ||
            String(user.site_id ?? "") === String(client.id)
        ).length,
      })),
    [clients, users]
  );

  const appendLog = useCallback((line: string) => {
    setLogLines((prev) => [...prev, line]);
  }, []);

  const apiGet = useCallback(
    async <T,>(resource: string, token: string): Promise<{ payload: unknown; data: T[] }> => {
      const payload = await proxyRequest({
        url: `${RESOURCE_SERVER}/${resource}?paginate=false`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      return { payload, data: normalizeCollection<T>(payload) };
    },
    []
  );

  const authenticateAndDiscover = useCallback(async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: clientSecret,
        scope: "all",
        tenant: TENANT,
      });
      const payload = await proxyRequest<{ access_token?: string }>({
        url: `${AUTH_SERVER}/token`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      if (typeof payload.access_token !== "string") {
        throw new Error("Authentication response did not include an access token.");
      }

      const token = payload.access_token as string;
      setAuthToken(token);
      setDiscoveryLoading(true);

      const probeDiscovery = async <T,>(
        label: string,
        resources: string[]
      ): Promise<DiscoveryProbeResult<T>> => {
        const attempts: DiscoveryProbeAttempt[] = [];

        for (const resource of resources) {
          try {
            const { payload, data } = await apiGet<T>(resource, token);
            const summary = describePayload(payload);
            attempts.push({
              resource,
              url: `${RESOURCE_SERVER}/${resource}?paginate=false`,
              topLevelKeys: summary.topLevelKeys,
              arrayKeys: summary.arrayKeys,
              normalizedCount: data.length,
              error: null,
            });

            if (data.length > 0) {
              return {
                data,
                warning:
                  resource === resources[0]
                    ? null
                    : `${label} resolved using fallback endpoint '${resource}'.`,
                attempts,
                matchedResource: resource,
              };
            }
          } catch (error) {
            attempts.push({
              resource,
              url: `${RESOURCE_SERVER}/${resource}?paginate=false`,
              topLevelKeys: [],
              arrayKeys: [],
              normalizedCount: 0,
              error: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }

        return {
          data: [] as T[],
          warning: `${label} returned no records from endpoints: ${resources.join(", ")}`,
          attempts,
          matchedResource: null,
        };
      };

      const settled = await Promise.all([
        probeDiscovery<Client>("Clients", ["Client", "Clients"]),
        probeDiscovery<HaloUser>("Users", ["Users", "User", "Contact", "Contacts"]),
        probeDiscovery<TicketType>("Ticket types", ["TicketType", "TicketTypes", "Tickettype"]),
        probeDiscovery<Category>("Categories", ["Category", "Categories"]),
        probeDiscovery<Agent>("Agents", ["Agent", "Agents"]),
        probeDiscovery<Priority>("Priorities", ["Priority", "Priorities"]),
        probeDiscovery<Status>("Statuses", ["Status", "Statuses"]),
        probeDiscovery<ExistingTicket>("Tickets", ["Tickets", "Ticket"]),
      ]);

      const [clientsResult, usersResult, ticketTypesResult, categoriesResult, agentsResult, prioritiesResult, statusesResult, ticketsResult] =
        settled;
      const nextClients = clientsResult.data;
      const nextUsers = usersResult.data;
      const warnings: string[] = [];
      const recentTickets = ticketsResult.data;
      let nextTicketTypes = ticketTypesResult.data;
      let nextCategories = categoriesResult.data;
      let nextAgents = agentsResult.data;
      let nextPriorities = prioritiesResult.data;
      let nextStatuses = statusesResult.data;

      if (recentTickets.length > 0) {
        if (nextTicketTypes.length === 0) {
          nextTicketTypes = deriveOptions<TicketType>(recentTickets, [
            { idKeys: ["tickettype_id", "type_id"], labelKeys: ["tickettypename", "tickettype", "type", "typename"] },
          ]);
          if (nextTicketTypes.length > 0) {
            warnings.push(`Ticket types derived from existing tickets (${nextTicketTypes.length}).`);
          }
        }

        if (nextCategories.length === 0) {
          nextCategories = deriveOptions<Category>(recentTickets, [
            { idKeys: ["category_1", "category1_id", "category_id"], labelKeys: ["category_1_name", "category1name", "category", "categoryname"] },
          ]);
          if (nextCategories.length > 0) {
            warnings.push(`Categories derived from existing tickets (${nextCategories.length}).`);
          }
        }

        if (nextAgents.length === 0) {
          nextAgents = deriveOptions<Agent>(recentTickets, [
            { idKeys: ["agent_id"], labelKeys: ["agent_name", "agent", "agentname"] },
          ]);
          if (nextAgents.length > 0) {
            warnings.push(`Agents derived from existing tickets (${nextAgents.length}).`);
          }
        }

        if (nextPriorities.length === 0) {
          nextPriorities = deriveOptions<Priority>(recentTickets, [
            { idKeys: ["priority_id"], labelKeys: ["priority_name", "priority", "priorityname"] },
          ]);
          if (nextPriorities.length > 0) {
            warnings.push(`Priorities derived from existing tickets (${nextPriorities.length}).`);
          }
        }

        if (nextStatuses.length === 0) {
          nextStatuses = deriveOptions<Status>(recentTickets, [
            { idKeys: ["status_id"], labelKeys: ["status_name", "status", "statusname"] },
          ]);
          if (nextStatuses.length > 0) {
            warnings.push(`Statuses derived from existing tickets (${nextStatuses.length}).`);
          }
        }
      }

      setDiscoveryProbeLog({
        clients: clientsResult.attempts,
        users: usersResult.attempts,
        ticketTypes: ticketTypesResult.attempts,
        categories: categoriesResult.attempts,
        agents: agentsResult.attempts,
        priorities: prioritiesResult.attempts,
        statuses: statusesResult.attempts,
        tickets: ticketsResult.attempts,
      });
      settled.forEach((result) => {
        if (result.warning) warnings.push(result.warning);
      });
      if (nextClients.length === 0) warnings.push("Clients lookup returned no usable records.");
      if (nextUsers.length === 0) warnings.push("Users lookup returned no usable records.");
      if (nextTicketTypes.length === 0) warnings.push("Ticket types lookup returned no usable records.");
      if (nextCategories.length === 0) warnings.push("Categories lookup returned no usable records.");
      if (nextAgents.length === 0) warnings.push("Agents lookup returned no usable records.");
      if (nextPriorities.length === 0) warnings.push("Priorities lookup returned no usable records.");
      if (nextStatuses.length === 0) warnings.push("Statuses lookup returned no usable records.");

      setClients(nextClients);
      setUsers(nextUsers);
      setTicketTypes(nextTicketTypes);
      setCategories(nextCategories);
      setAgents(nextAgents);
      setPriorities(nextPriorities);
      setStatuses(nextStatuses);
      setDiscoveryWarnings(warnings);
      setTotalTickets(nextClients.length * 10);
      setLogLines([]);
      setTicketsCreated(0);
      setPanelPhase("preview");
      setModalOpen(false);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed");
    } finally {
      setAuthLoading(false);
      setDiscoveryLoading(false);
    }
  }, [apiGet, clientSecret]);

  const generateDemoData = useCallback(async () => {
    if (!authToken) return;

    if (!ticketTypes.length || !categories.length) {
      setDiscoveryWarnings((prev) => [
        ...prev,
        "Ticket generation requires at least one ticket type and one category from Halo.",
      ]);
      return;
    }

    setPanelPhase("generating");
    setLogLines([]);
    setTicketsCreated(0);

    const safeTicketTypes = ticketTypes;
    const safeCategories = categories;
    const safeAgents = agents;
    const safePriorities = priorities;
    const safeStatuses = statuses;

    for (let clientIndex = 0; clientIndex < clients.length; clientIndex += 1) {
      const client = clients[clientIndex];
      const clientUsers = users.filter(
        (user) =>
          String(user.client_id ?? "") === String(client.id) ||
          String(user.site_id ?? "") === String(client.id)
      );

      if (clientUsers.length === 0) {
        appendLog(`⚠️ [${client.name}] No users found — skipping`);
        continue;
      }

      for (let ticketIndex = 0; ticketIndex < TICKET_TEMPLATES.length; ticketIndex += 1) {
        const template = TICKET_TEMPLATES[ticketIndex];
        appendLog(`⏳ [${client.name}] Creating ticket ${ticketIndex + 1}/10...`);

        const user = clientUsers[Math.floor(Math.random() * clientUsers.length)];
        const agent = safeAgents.length
          ? safeAgents[(clientIndex + ticketIndex) % safeAgents.length]
          : null;
        const ticketType = safeTicketTypes[(clientIndex + ticketIndex) % safeTicketTypes.length];
        const category = safeCategories[(clientIndex + ticketIndex) % safeCategories.length];
        const priority = safePriorities.length
          ? safePriorities[(ticketIndex + clientIndex) % safePriorities.length]
          : null;
        const status = safeStatuses.length
          ? safeStatuses[(ticketIndex * 2 + clientIndex) % safeStatuses.length]
          : null;

        const ticket: GeneratedTicket = {
          tickettype_id: ticketType.id,
          summary: template.summary,
          details: template.details,
          client_id: client.id,
          user_id: user.id,
          dateoccurred: isoDateWithinLast90Days(ticketIndex + clientIndex),
          ...(agent?.id ? { agent_id: agent.id } : {}),
          ...(priority?.id ? { priority_id: priority.id } : {}),
          ...(status?.id ? { status_id: status.id } : {}),
          ...(category?.id ? { category_1: category.id } : {}),
        };

        try {
          await proxyRequest({
            url: `${RESOURCE_SERVER}/Tickets`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: [ticket],
          });
          setTicketsCreated((prev) => prev + 1);
          appendLog(`✅ [${client.name}] Ticket ${ticketIndex + 1}/10 created — "${template.summary}"`);
        } catch (error) {
          appendLog(
            `❌ [${client.name}] Ticket ${ticketIndex + 1}/10 failed — ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }

        await sleep(100);
      }
    }

    setPanelPhase("complete");
  }, [agents, appendLog, authToken, categories, clients, priorities, statuses, ticketTypes, users]);

  const resetState = useCallback(() => {
    setModalOpen(false);
    setClientSecret("");
    setAuthToken("");
    setAuthError(null);
    setPanelPhase("idle");
    setDiscoveryWarnings([]);
    setClients([]);
    setUsers([]);
    setTicketTypes([]);
    setCategories([]);
    setAgents([]);
    setPriorities([]);
    setStatuses([]);
    setLogLines([]);
    setTicketsCreated(0);
    setTotalTickets(0);
    setDiscoveryProbeLog({});
  }, []);

  return (
    <div className="relative inline-flex flex-col items-end">
      <Button
        type="button"
        variant="outline"
        className="border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary"
        onClick={() => setModalOpen(true)}
      >
        <TicketPlus className="mr-2 h-4 w-4" />
        {triggerLabel}
      </Button>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-heading text-lg">Connect to PSA</DialogTitle>
            <DialogDescription>
              Paste the Halo PSA client secret to authenticate and preview demo ticket generation.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {[
              { label: "Resource Server", value: RESOURCE_SERVER },
              { label: "Authorisation Server", value: AUTH_SERVER },
              { label: "Client ID", value: CLIENT_ID },
              { label: "Tenant", value: TENANT },
            ].map((field) => (
              <div key={field.label} className="space-y-2">
                <Label>{field.label}</Label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={field.value} disabled className="pl-9 text-muted-foreground" />
                </div>
              </div>
            ))}

            <div className="space-y-2">
              <Label htmlFor="psa-client-secret">Client Secret</Label>
              <Input
                id="psa-client-secret"
                type="password"
                autoFocus
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder="Paste client secret"
              />
            </div>

            {authError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {authError}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={authenticateAndDiscover} disabled={!clientSecret.trim() || authLoading}>
              {(authLoading || discoveryLoading) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Connect & Preview
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {panelPhase !== "idle" && (
        <div className="absolute right-0 top-full z-30 mt-4 w-[min(960px,calc(100vw-3rem))] rounded-lg border border-border bg-card p-5 shadow-2xl">
          {panelPhase === "preview" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-heading text-lg font-bold text-foreground">PSA Demo Data Preview</h3>
                  <p className="text-sm text-muted-foreground">
                    Found {clients.length} clients, {users.length} users, {ticketTypes.length} ticket types
                  </p>
                </div>
                <Badge variant="secondary" className="bg-primary/15 text-primary">
                  {totalTickets} tickets
                </Badge>
              </div>

              {discoveryWarnings.length > 0 && (
                <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
                  {discoveryWarnings.map((warning) => (
                    <div key={warning} className="flex items-start gap-2">
                      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{warning}</span>
                    </div>
                  ))}
                </div>
              )}

              {(!ticketTypes.length || !categories.length) && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  Generation is disabled until at least one ticket type and one category are discovered.
                </div>
              )}

              <ScrollArea className="h-72 rounded-md border border-border">
                <div className="space-y-2 p-3">
                  {clientUserCounts.map(({ client, count }) => (
                    <div key={String(client.id)} className="flex items-center justify-between rounded-md border border-border/70 px-3 py-2 text-sm">
                      <span className="text-foreground">{client.name}</span>
                      <Badge variant="outline">{count} users</Badge>
                    </div>
                  ))}
                </div>
              </ScrollArea>

              <div className="rounded-md border border-border bg-surface-raised/40 p-3">
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Discovery Debug
                </h4>
                <ScrollArea className="h-56">
                  <div className="space-y-3 pr-3 text-xs">
                    {Object.entries(discoveryProbeLog).map(([group, attempts]) => (
                      <div key={group} className="rounded-md border border-border/70 bg-card px-3 py-2">
                        <div className="mb-2 font-medium text-foreground">{group}</div>
                        <div className="space-y-2">
                          {attempts.map((attempt) => (
                            <div key={attempt.url} className="rounded border border-border/60 px-2 py-2">
                              <div className="font-mono text-muted-foreground">{attempt.url}</div>
                              <div className="mt-1 text-muted-foreground">
                                arrays: {attempt.arrayKeys.length ? attempt.arrayKeys.join(", ") : "none"} | count: {attempt.normalizedCount}
                              </div>
                              <div className="mt-1 text-muted-foreground">
                                top-level keys: {attempt.topLevelKeys.length ? attempt.topLevelKeys.join(", ") : "none"}
                              </div>
                              {attempt.error && (
                                <div className="mt-1 text-destructive">{attempt.error}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={resetState}>
                  Cancel
                </Button>
                <Button
                  onClick={generateDemoData}
                  disabled={!clients.length || !users.length || !ticketTypes.length || !categories.length}
                >
                  <PlugZap className="mr-2 h-4 w-4" />
                  Generate Demo Data
                </Button>
              </div>
            </div>
          )}

          {(panelPhase === "generating" || panelPhase === "complete") && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-heading text-lg font-bold text-foreground">PSA Demo Data Generation</h3>
                  <p className="text-sm text-muted-foreground">
                    {ticketsCreated} of {totalTickets} tickets processed
                  </p>
                </div>
                {panelPhase === "complete" && (
                  <Badge className="bg-success/15 text-success">Complete</Badge>
                )}
              </div>

              <Progress value={totalTickets ? (ticketsCreated / totalTickets) * 100 : 0} />

              <ScrollArea className="h-80 rounded-md border border-border">
                <div className="space-y-2 p-3 text-sm">
                  {logLines.map((line, index) => (
                    <div key={`${line}-${index}`} className="font-mono text-muted-foreground">
                      {line}
                    </div>
                  ))}
                </div>
              </ScrollArea>

              {panelPhase === "complete" && (
                <div className="flex justify-end">
                  <Button onClick={resetState}>Done</Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
