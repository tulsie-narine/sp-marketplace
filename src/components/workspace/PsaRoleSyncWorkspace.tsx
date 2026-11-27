import { useState, useEffect, useMemo, useCallback } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Loader2,
  Search,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Play,
  Plug,
  Save,
  Trash2,
  X,
  ArrowLeftRight,
  Plus,
  Link2,
} from "lucide-react";
import {
  CW_SITES,
  PSA_OPTIONS,
  createCsRoles,
  SKIP_REASON_LABELS,
  deletePsaConnection,
  discoverPsa,
  emptyPsaRoleSyncConfig,
  fieldRoleKey,
  isFieldRoleKey,
  valueKey,
  getPsaConnections,
  listPsaRoleSyncRuns,
  listPsaRoleSyncTasks,
  psaOption,
  psaShortName,
  runPsaRoleSync,
  savePsaConnection,
  savePsaRoleSyncTask,
  type DiscoveredField,
  type DiscoveredMember,
  type Discovery,
  type PsaConnection,
  type PsaRoleSyncConfig,
  type PsaType,
  type RunDetails,
  type RunRecord,
} from "@/lib/psa-role-sync-api";

// --- Constants ---

const PAGE_SIZE = 8;
const TASK_NAME = "PSA role sync";
const INTERVALS: { value: PsaRoleSyncConfig["syncIntervalDays"]; label: string }[] = [
  { value: 30, label: "Monthly (every 30 days)" },
  { value: 14, label: "Every 14 days" },
  { value: 7, label: "Weekly" },
];
const MEMBER_FILTERS = [
  { value: "all", label: "All members" },
  { value: "matched", label: "Matched" },
  { value: "unmatched", label: "No ScalePad user" },
  { value: "inactive", label: "Inactive" },
];
/** Dropdown value for "create this PSA role in ScalePad". Not a real role id. */
const CREATE_ROLE = "__create__";
/** "Use as" value for the custom field that sets the client segment. */
const USE_SEGMENT = "__segment__";

const sameLabel = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

const ACTION_LABELS: Record<string, string> = { assign: "Assign", "set-role": "Set role", "change-role": "Change role" };
const STATUS_COLORS: Record<string, string> = {
  success: "bg-success/15 text-success",
  partial: "bg-warning/15 text-warning",
  failed: "bg-destructive/15 text-destructive",
  running: "bg-primary/15 text-primary",
};

const inputClass =
  "w-full h-8 px-3 bg-surface-raised border border-border rounded-md text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary";
const selectClass = "h-7 px-2 bg-surface-raised border border-border rounded text-[11px] text-foreground focus:outline-none";

/** Form values for the connection fields of one PSA; "customSite" backs ConnectWise's "Other" site. */
type ConnForm = Record<string, string>;

function connFormFor(psaType: PsaType, connection: PsaConnection | undefined): ConnForm {
  const form: ConnForm = {};
  for (const field of psaOption(psaType).fields) form[field.key] = field.secret ? "" : connection?.settings[field.key] || "";
  if (psaType === "connectwise") {
    const site = connection?.settings.site || "";
    const known = !site || CW_SITES.some((s) => s.value === site);
    form.site = known ? site || CW_SITES[0].value : "custom";
    form.customSite = known ? "" : site;
  }
  return form;
}

// --- Sub-components ---

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${className}`}>{children}</span>;
}

function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-3 py-2 border-t border-border">
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
      >
        <ChevronLeft className="w-3 h-3" /> Prev
      </button>
      <span className="text-[10px] text-muted-foreground">Page {page} of {totalPages}</span>
      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
      >
        Next <ChevronRight className="w-3 h-3" />
      </button>
    </div>
  );
}

function usePaged<T>(items: T[], resetKey: unknown) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [resetKey]);
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  return { page: safePage, totalPages, setPage, rows: items.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) };
}

function TabBar<T extends string>({ tabs, active, onChange }: { tabs: [T, string][]; active: T; onChange: (t: T) => void }) {
  return (
    <div className="flex border-b border-border">
      {tabs.map(([key, label]) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
            active === key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

function StatCard({ label, value, tone = "text-foreground" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="bg-surface-raised border border-border rounded-md px-3 py-2">
      <p className={`text-lg font-heading font-bold ${tone}`}>{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground text-center py-8 px-4">{children}</p>;
}

// --- PSA picker (first step) ---

function PsaPicker({
  current,
  connections,
  onPick,
  onCancel,
}: {
  current: PsaType | null;
  connections: PsaConnection[];
  onPick: (psaType: PsaType) => void;
  onCancel?: () => void;
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <div className="flex items-start justify-between mb-1">
        <h3 className="font-heading font-bold text-sm text-foreground">Which PSA do you use?</h3>
        {onCancel && (
          <button onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
            <X className="w-3 h-3" /> Cancel
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground mb-5">
        PSA Role Sync reads client teams from your PSA and assigns the same people to each client's account team in ScalePad.
      </p>
      <div className="grid grid-cols-3 gap-3">
        {PSA_OPTIONS.map((option) => {
          const connected = connections.some((c) => c.psa_type === option.id);
          const selected = current === option.id;
          return (
            <button
              key={option.id}
              disabled={!option.available}
              onClick={() => option.available && onPick(option.id as PsaType)}
              className={`text-left p-4 rounded-lg border transition-colors ${
                selected ? "border-primary bg-primary/10" : "border-border bg-surface-raised"
              } ${option.available ? "hover:border-primary/60" : "opacity-50 cursor-not-allowed"}`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-medium text-foreground">{option.label}</span>
                {!option.available ? (
                  <Badge className="bg-muted text-muted-foreground">Coming soon</Badge>
                ) : selected ? (
                  <Badge className="bg-primary/15 text-primary">Current</Badge>
                ) : connected ? (
                  <Badge className="bg-success/15 text-success">Connected</Badge>
                ) : null}
              </div>
              <p className="text-[11px] text-muted-foreground">{option.blurb}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Results ---

type ResultView = { mode: "dry-run" | "live"; status: string; startedAt: string; summary: Record<string, number>; details: Partial<RunDetails>; error?: string | null };

function RunResults({ result, psaName }: { result: ResultView; psaName: string }) {
  const [tab, setTab] = useState<"actions" | "segments" | "skips" | "notInPsa" | "errors">("actions");
  const actions = result.details.actions || [];
  const segmentChanges = result.details.segmentChanges || [];
  const skips = result.details.skips || [];
  const notInPsa = result.details.notInPsa || [];
  const errors = result.details.errors || [];
  const s = result.summary || {};
  const skipped = skips.filter((x) => x.reason !== "duplicate-role").length;

  const actionsPaged = usePaged(actions, tab);
  const skipsPaged = usePaged(skips, tab);
  const notInPsaPaged = usePaged(notInPsa, tab);
  const errorsPaged = usePaged(errors, tab);
  const segmentsPaged = usePaged(segmentChanges, tab);
  const showSegments = segmentChanges.length > 0 || (s.segmentPlanned || 0) + (s.segmentUnchanged || 0) > 0;

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">{result.mode === "live" ? "Live run" : "Dry run"}</span>
          <Badge className={STATUS_COLORS[result.status] || "bg-muted text-muted-foreground"}>{result.status}</Badge>
        </div>
        <span className="text-[10px] text-muted-foreground">{new Date(result.startedAt).toLocaleString()}</span>
      </div>
      {result.error && (
        <div className="px-4 py-2 border-b border-border text-[11px] text-destructive flex items-start gap-1.5">
          <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {result.error}
        </div>
      )}
      <div className={`grid ${showSegments ? "grid-cols-5" : "grid-cols-4"} gap-2 p-3 border-b border-border`}>
        <StatCard
          label={result.mode === "live" ? "Assigned" : "To assign"}
          value={result.mode === "live" ? s.applied || 0 : s.planned || 0}
          tone="text-success"
        />
        {showSegments && (
          <StatCard
            label={result.mode === "live" ? "Segments set" : "Segments to set"}
            value={result.mode === "live" ? s.segmentApplied || 0 : s.segmentPlanned || 0}
            tone="text-success"
          />
        )}
        <StatCard label="Already correct" value={(s.unchanged || 0) + (s.segmentUnchanged || 0)} />
        <StatCard label="Skipped" value={skipped} tone={skipped ? "text-warning" : "text-foreground"} />
        <StatCard label="Errors" value={s.errors || 0} tone={s.errors ? "text-destructive" : "text-foreground"} />
      </div>
      <TabBar<typeof tab>
        tabs={[
          ["actions", `${result.mode === "live" ? "Changes" : "Planned"} (${actions.length})`],
          ...(showSegments ? ([["segments", `Segments (${segmentChanges.length})`]] as [typeof tab, string][]) : []),
          ["skips", `Skipped (${skips.length})`],
          ["notInPsa", `In ScalePad only (${notInPsa.length})`],
          ["errors", `Errors (${errors.length})`],
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="min-h-[200px]">
        {tab === "actions" && (
          <>
            {actionsPaged.rows.length === 0 ? (
              <EmptyRow>Nothing to change. Every mapped {psaName} team member is already assigned.</EmptyRow>
            ) : (
              actionsPaged.rows.map((a, i) => (
                <div key={`${a.clientName}-${a.userLabel}-${i}`} className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border">
                  <div className="min-w-0">
                    <p className="text-xs text-foreground truncate">{a.userLabel}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{a.clientName}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge className="bg-primary/15 text-primary">{a.roleLabel}</Badge>
                    <Badge className={a.failed ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"}>
                      {a.failed ? "Failed" : ACTION_LABELS[a.kind] || a.kind}
                    </Badge>
                  </div>
                </div>
              ))
            )}
            <Pagination page={actionsPaged.page} totalPages={actionsPaged.totalPages} onPageChange={actionsPaged.setPage} />
          </>
        )}
        {tab === "segments" && (
          <>
            {segmentsPaged.rows.length === 0 ? (
              <EmptyRow>No segment changes. Every client with a value is already in the right segment.</EmptyRow>
            ) : (
              segmentsPaged.rows.map((x, i) => (
                <div key={`${x.clientName}-${i}`} className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border">
                  <div className="min-w-0">
                    <p className="text-xs text-foreground truncate">{x.clientName}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{psaName} value: {x.value}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[10px] text-muted-foreground">{x.from} →</span>
                    <Badge className="bg-primary/15 text-primary">{x.to}</Badge>
                    {x.failed && <Badge className="bg-destructive/15 text-destructive">Failed</Badge>}
                  </div>
                </div>
              ))
            )}
            <Pagination page={segmentsPaged.page} totalPages={segmentsPaged.totalPages} onPageChange={segmentsPaged.setPage} />
          </>
        )}
        {tab === "skips" && (
          <>
            {skipsPaged.rows.length === 0 ? (
              <EmptyRow>Nothing was skipped.</EmptyRow>
            ) : (
              skipsPaged.rows.map((x, i) => (
                <div key={`${x.clientName}-${x.memberLabel}-${i}`} className="px-4 py-2 border-b border-border">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-foreground truncate">{x.memberLabel}</p>
                    <Badge className="bg-warning/15 text-warning">{SKIP_REASON_LABELS[x.reason] || x.reason}</Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground truncate">{x.clientName} · {x.detail}</p>
                </div>
              ))
            )}
            <Pagination page={skipsPaged.page} totalPages={skipsPaged.totalPages} onPageChange={skipsPaged.setPage} />
          </>
        )}
        {tab === "notInPsa" && (
          <>
            <p className="px-4 py-2 text-[10px] text-muted-foreground border-b border-border">
              Assigned in ScalePad but not on the client's {psaName} team. The sync never removes these; review them by hand.
            </p>
            {notInPsaPaged.rows.length === 0 ? (
              <EmptyRow>No differences.</EmptyRow>
            ) : (
              notInPsaPaged.rows.map((x, i) => (
                <div key={`${x.clientName}-${x.userLabel}-${i}`} className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border">
                  <div className="min-w-0">
                    <p className="text-xs text-foreground truncate">{x.userLabel}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{x.clientName}</p>
                  </div>
                  <Badge className="bg-muted text-muted-foreground">{x.roleLabel}</Badge>
                </div>
              ))
            )}
            <Pagination page={notInPsaPaged.page} totalPages={notInPsaPaged.totalPages} onPageChange={notInPsaPaged.setPage} />
          </>
        )}
        {tab === "errors" && (
          <>
            {errorsPaged.rows.length === 0 ? (
              <EmptyRow>No errors.</EmptyRow>
            ) : (
              errorsPaged.rows.map((e, i) => (
                <p key={i} className="px-4 py-2 border-b border-border text-[11px] text-destructive break-words">{e}</p>
              ))
            )}
            <Pagination page={errorsPaged.page} totalPages={errorsPaged.totalPages} onPageChange={errorsPaged.setPage} />
          </>
        )}
      </div>
    </div>
  );
}

// --- Main Component ---

export function PsaRoleSyncWorkspace() {
  // Data
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connections, setConnections] = useState<PsaConnection[]>([]);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  // Saved task (one per ScalePad key; config.psaType says which PSA it syncs from)
  const [taskId, setTaskId] = useState<string | undefined>();
  const [config, setConfig] = useState<PsaRoleSyncConfig>(emptyPsaRoleSyncConfig());
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // PSA picker: shown first until a PSA is chosen, and again from "Change PSA"
  const [psaChosen, setPsaChosen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<PsaType | null>(null);

  // Left panel
  const [leftTab, setLeftTab] = useState<"roles" | "members" | "fields" | "clients">("roles");
  const [fieldSearch, setFieldSearch] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [scopeSearch, setScopeSearch] = useState("");
  const [linkDrafts, setLinkDrafts] = useState<Record<string, string>>({});
  const [roleSearch, setRoleSearch] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [memberFilter, setMemberFilter] = useState("all");
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});

  // Right panel
  const [rightTab, setRightTab] = useState<"connection" | "run" | "history">("connection");
  const [connForm, setConnForm] = useState<ConnForm>(() => connFormFor("connectwise", undefined));
  const [connSaving, setConnSaving] = useState(false);
  const [running, setRunning] = useState<"dry-run" | "live" | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [checkedRoleIds, setCheckedRoleIds] = useState<Set<string>>(new Set());
  const [pendingCreate, setPendingCreate] = useState<string[] | null>(null);
  // What the create dialog lists; kept after it closes so the closing animation doesn't show "0 roles".
  const [createDialogIds, setCreateDialogIds] = useState<string[]>([]);
  const [creatingRoles, setCreatingRoles] = useState(false);
  const [result, setResult] = useState<ResultView | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  const psaType = config.psaType;
  const psa = psaOption(psaType);
  const psaName = psaShortName(psaType);
  const connection = connections.find((c) => c.psa_type === psaType);

  const updateConfig = (patch: Partial<PsaRoleSyncConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
    setDirty(true);
  };

  const runDiscovery = useCallback(async (type: PsaType, overrides: Record<string, string>, links: Record<string, string> = {}) => {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      setDiscovery(await discoverPsa(type, overrides, links));
    } catch (err) {
      setDiscovery(null);
      setDiscoverError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscovering(false);
    }
  }, []);

  // Initial load: saved connections + settings, then discovery when the chosen PSA is connected.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [conns, tasks] = await Promise.all([getPsaConnections(), listPsaRoleSyncTasks()]);
        if (cancelled) return;
        setConnections(conns);
        const task = tasks[0];
        if (!task) return; // First visit: the PSA picker shows.
        const loadedConfig = { ...emptyPsaRoleSyncConfig(), ...(task.config || {}) };
        setTaskId(task.id);
        setConfig(loadedConfig);
        setScheduleEnabled(task.schedule_enabled);
        setPsaChosen(true);
        const conn = conns.find((c) => c.psa_type === loadedConfig.psaType);
        setConnForm(connFormFor(loadedConfig.psaType, conn));
        if (conn) {
          setRightTab("run");
          runDiscovery(loadedConfig.psaType, loadedConfig.emailOverrides, loadedConfig.clientLinks);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [runDiscovery]);

  const loadRuns = useCallback(async () => {
    if (!taskId) return;
    setRunsLoading(true);
    try {
      setRuns(await listPsaRoleSyncRuns(taskId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRunsLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (rightTab === "history") loadRuns();
  }, [rightTab, loadRuns]);

  // --- Derived lists ---

  const filteredRoles = useMemo(() => {
    const q = roleSearch.trim().toLowerCase();
    return (discovery?.psaRoles || []).filter((r) => !q || r.name.toLowerCase().includes(q));
  }, [discovery, roleSearch]);
  const rolesPaged = usePaged(filteredRoles, roleSearch);
  const mappedCount = Object.values(config.roleMap).filter(Boolean).length;
  const segmentOn = psaType === "connectwise" && !!config.segmentFieldId;
  const hasMapping = mappedCount > 0 || segmentOn;
  // A test scope needs at least one client, and an engine that honors it (an older one would sync everyone).
  const scopeSelected = config.syncScope === "selected";
  const scopeBlock = !scopeSelected
    ? null
    : discovery && !discovery.scopeSupported
      ? "Test runs on selected clients need the updated engine. Switch to all linked clients, or ask your admin to redeploy psa-role-sync."
      : config.scopeClientIds.length === 0
        ? "Pick at least one client to test on."
        : null;
  const canRun = hasMapping && !scopeBlock;
  const runBlockReason = !hasMapping
    ? `Map at least one ${psaName} role${psaType === "connectwise" ? " or custom field" : ""} first.`
    : scopeBlock;

  const linkedNameById = useMemo(() => new Map((discovery?.clients.linkedList || []).map((c) => [c.id, c.name])), [discovery]);
  const filteredScope = useMemo(() => {
    const q = scopeSearch.trim().toLowerCase();
    return (discovery?.clients.linkedList || []).filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [discovery, scopeSearch]);
  const scopePaged = usePaged(filteredScope, scopeSearch);
  const toggleScopeClient = (id: string, on: boolean) => {
    const ids = new Set(config.scopeClientIds);
    if (on) ids.add(id);
    else ids.delete(id);
    updateConfig({ scopeClientIds: [...ids] });
  };

  const filteredFields = useMemo(() => {
    const q = fieldSearch.trim().toLowerCase();
    return (discovery?.customFields || []).filter((f) => !q || f.caption.toLowerCase().includes(q));
  }, [discovery, fieldSearch]);
  const fieldsPaged = usePaged(filteredFields, fieldSearch);

  const filteredUnlinked = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    return (discovery?.clients.unlinked || []).filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [discovery, clientSearch]);
  const unlinkedPaged = usePaged(filteredUnlinked, clientSearch);

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    return (discovery?.members || []).filter(
      (m) =>
        (memberFilter === "all" || m.status === memberFilter) &&
        (!q || [m.name, m.identifier, m.email].some((v) => (v || "").toLowerCase().includes(q))),
    );
  }, [discovery, memberSearch, memberFilter]);
  const membersPaged = usePaged(filteredMembers, `${memberSearch}|${memberFilter}`);
  const memberCounts = useMemo(() => {
    const counts = { matched: 0, unmatched: 0, inactive: 0 };
    for (const m of discovery?.members || []) counts[m.status]++;
    return counts;
  }, [discovery]);

  // --- PSA choice ---

  const applyPsa = async (next: PsaType) => {
    setPendingSwitch(null);
    setPickerOpen(false);
    setPsaChosen(true);
    if (next === psaType && taskId) return;
    // Mappings and email matches belong to one PSA, so a switch starts them fresh.
    const nextConfig = { ...emptyPsaRoleSyncConfig(next), syncIntervalDays: config.syncIntervalDays, overwriteRoles: config.overwriteRoles };
    setConfig(nextConfig);
    setDiscovery(null);
    setDiscoverError(null);
    setResult(null);
    setRoleSearch("");
    setMemberSearch("");
    setFieldSearch("");
    setClientSearch("");
    setLinkDrafts({});
    setLeftTab("roles");
    setOverrideDrafts({});
    setCheckedRoleIds(new Set());
    const conn = connections.find((c) => c.psa_type === next);
    setConnForm(connFormFor(next, conn));
    setRightTab("connection");
    if (taskId) {
      // Save straight away with the schedule off, so a scheduled run never uses the old PSA's mapping.
      try {
        const saved = await savePsaRoleSyncTask({ id: taskId, name: TASK_NAME, config: nextConfig, scheduleEnabled: false });
        setScheduleEnabled(saved.schedule_enabled);
        setDirty(false);
      } catch (err) {
        setDirty(true);
        toast.error(err instanceof Error ? err.message : String(err));
      }
    } else {
      setDirty(true);
    }
    if (conn) {
      setRightTab("run");
      runDiscovery(next, nextConfig.emailOverrides, nextConfig.clientLinks);
    }
  };

  const handlePick = (next: PsaType) => {
    const hasWork = canRun || Object.keys(config.emailOverrides).length > 0 || Object.keys(config.clientLinks).length > 0 || scheduleEnabled;
    if (psaChosen && next !== psaType && hasWork) setPendingSwitch(next);
    else applyPsa(next);
  };

  // --- Role mapping ---

  const setRoleMappings = (updates: Record<string, string>) => {
    // rolePriority follows the on-screen order: it decides which role wins when a member holds two.
    const next: Record<string, string> = {};
    const priority: string[] = [];
    // Team roles first, then custom fields used as roles.
    const ids = [...(discovery?.psaRoles || []).map((r) => r.id), ...(discovery?.customFields || []).map((f) => fieldRoleKey(f.id))];
    for (const id of ids) {
      const value = id in updates ? updates[id] : config.roleMap[id];
      if (value) {
        next[id] = value;
        priority.push(id);
      }
    }
    updateConfig({ roleMap: next, rolePriority: priority });
  };

  const setRoleMapping = (psaRoleId: string, csRoleId: string) => {
    if (csRoleId === CREATE_ROLE) {
      openCreateDialog([psaRoleId]);
      return;
    }
    setRoleMappings({ [psaRoleId]: csRoleId });
  };

  // --- Creating ScalePad roles from PSA roles ---

  const openCreateDialog = (ids: string[]) => {
    setCreateDialogIds(ids);
    setPendingCreate(ids);
  };

  const csRoleNamed = (name: string) => discovery?.csRoles.find((r) => sameLabel(r.label, name));
  const psaRoleName = (id: string) =>
    isFieldRoleKey(id)
      ? discovery?.customFields.find((f) => fieldRoleKey(f.id) === id)?.caption || id
      : discovery?.psaRoles.find((r) => r.id === id)?.name || id;

  const toggleRoleCheck = (id: string) =>
    setCheckedRoleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allRolesOnPageChecked = rolesPaged.rows.length > 0 && rolesPaged.rows.every((r) => checkedRoleIds.has(r.id));
  const toggleRolePage = () =>
    setCheckedRoleIds((prev) => {
      const next = new Set(prev);
      for (const r of rolesPaged.rows) {
        if (allRolesOnPageChecked) next.delete(r.id);
        else next.add(r.id);
      }
      return next;
    });

  const handleCreateRoles = async () => {
    const ids = pendingCreate || [];
    setPendingCreate(null);
    if (!ids.length || !discovery) return;
    setCreatingRoles(true);
    try {
      const { results, csRoles } = await createCsRoles(ids.map(psaRoleName));
      setDiscovery((d) => (d ? { ...d, csRoles } : d));
      const updates: Record<string, string> = {};
      const failed: string[] = [];
      let created = 0;
      let reused = 0;
      for (const id of ids) {
        const result = results.find((r) => sameLabel(r.label, psaRoleName(id)));
        if (result?.id) {
          updates[id] = result.id;
          if (result.created) created++;
          else reused++;
        } else {
          failed.push(`${psaRoleName(id)}${result?.error ? `: ${result.error}` : ""}`);
        }
      }
      if (Object.keys(updates).length) setRoleMappings(updates);
      setCheckedRoleIds(new Set());
      if (created || reused) {
        toast.success(
          [created ? `Created ${created} ScalePad role(s)` : "", reused ? `${reused} already existed and were mapped` : ""].filter(Boolean).join("; "),
        );
      }
      if (failed.length) toast.error(`Couldn't create: ${failed.join("; ")}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingRoles(false);
    }
  };

  // --- Overrides ---

  const overrideKey = (m: DiscoveredMember) => (m.email || m.identifier).toLowerCase();

  const addOverride = (m: DiscoveredMember) => {
    const target = (overrideDrafts[m.id] || "").trim();
    if (!target) return;
    const next = { ...config.emailOverrides, [overrideKey(m)]: target };
    updateConfig({ emailOverrides: next });
    setOverrideDrafts((d) => ({ ...d, [m.id]: "" }));
    runDiscovery(psaType, next, config.clientLinks);
  };

  const removeOverride = (m: DiscoveredMember) => {
    const next = { ...config.emailOverrides };
    delete next[overrideKey(m)];
    delete next[m.identifier.toLowerCase()];
    updateConfig({ emailOverrides: next });
    runDiscovery(psaType, next, config.clientLinks);
  };

  // --- Custom fields (ConnectWise) ---

  const fieldUse = (f: DiscoveredField) =>
    config.segmentFieldId === f.id ? USE_SEGMENT : config.roleMap[fieldRoleKey(f.id)] || "";

  const setFieldUse = (f: DiscoveredField, use: string) => {
    if (use === CREATE_ROLE) {
      openCreateDialog([fieldRoleKey(f.id)]);
      return;
    }
    if (use === USE_SEGMENT) {
      // Values that exactly match a segment name are mapped straight away; the rest wait for a choice.
      const segmentMap = { ...config.segmentMap };
      for (const v of f.values) {
        const same = discovery?.segments.find((seg) => sameLabel(seg.label, v.value));
        if (!segmentMap[v.key] && same) segmentMap[v.key] = same.id;
      }
      const roleMap = { ...config.roleMap };
      delete roleMap[fieldRoleKey(f.id)];
      updateConfig({ segmentFieldId: f.id, segmentMap, roleMap, rolePriority: config.rolePriority.filter((id) => id !== fieldRoleKey(f.id)) });
      return;
    }
    if (config.segmentFieldId === f.id) updateConfig({ segmentFieldId: "" });
    setRoleMappings({ [fieldRoleKey(f.id)]: use });
  };

  const setSegmentForValue = (key: string, segmentId: string) => {
    const segmentMap = { ...config.segmentMap };
    if (segmentId) segmentMap[key] = segmentId;
    else delete segmentMap[key];
    updateConfig({ segmentMap });
  };

  const addValueOverride = (key: string) => {
    const target = (overrideDrafts[`value:${key}`] || "").trim();
    if (!target) return;
    const next = { ...config.emailOverrides, [key]: target };
    updateConfig({ emailOverrides: next });
    setOverrideDrafts((d) => ({ ...d, [`value:${key}`]: "" }));
    runDiscovery(psaType, next, config.clientLinks);
  };

  const removeValueOverride = (key: string) => {
    const next = { ...config.emailOverrides };
    delete next[key];
    updateConfig({ emailOverrides: next });
    runDiscovery(psaType, next, config.clientLinks);
  };

  // --- Manual client links ---

  const companyLabel = (c: { id: string; name: string }) => `${c.name} (#${c.id})`;
  const companyByLabel = useMemo(() => new Map((discovery?.psaCompanies || []).map((c) => [companyLabel(c), c])), [discovery]);

  const linkClient = (clientId: string) => {
    const company = companyByLabel.get((linkDrafts[clientId] || "").trim());
    if (!company) {
      toast.error(`Pick a ${psaName} company from the list.`);
      return;
    }
    const clientLinks = { ...config.clientLinks, [clientId]: company.id };
    updateConfig({ clientLinks });
    setLinkDrafts((d) => ({ ...d, [clientId]: "" }));
    runDiscovery(psaType, config.emailOverrides, clientLinks);
  };

  const unlinkClient = (clientId: string) => {
    const clientLinks = { ...config.clientLinks };
    delete clientLinks[clientId];
    updateConfig({ clientLinks });
    runDiscovery(psaType, config.emailOverrides, clientLinks);
  };

  // --- Save settings ---

  const saveSettings = async (enabled = scheduleEnabled) => {
    setSaving(true);
    try {
      const saved = await savePsaRoleSyncTask({ id: taskId, name: TASK_NAME, config, scheduleEnabled: enabled });
      setTaskId(saved.id);
      setScheduleEnabled(saved.schedule_enabled);
      setDirty(false);
      return saved.id;
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    try {
      await saveSettings();
      toast.success("Sync settings saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleScheduleToggle = async (enabled: boolean) => {
    if (enabled && !canRun) {
      toast.error(runBlockReason || "Finish the setup before turning on the schedule.");
      return;
    }
    try {
      await saveSettings(enabled);
      toast.success(enabled ? "Schedule on. Your ScalePad API key is saved for scheduled runs." : "Schedule off");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  // --- Connection ---

  const handleSaveConnection = async () => {
    const fields: Record<string, string> = {};
    for (const field of psa.fields) fields[field.key] = (connForm[field.key] || "").trim();
    if (psaType === "connectwise" && connForm.site === "custom") fields.site = (connForm.customSite || "").trim();
    const missing = psa.fields.filter((f) => !fields[f.key] && !f.optional && !(f.secret && connection));
    if (missing.length) {
      toast.error(`Fill in ${missing.map((f) => f.label).join(", ")}.`);
      return;
    }
    setConnSaving(true);
    try {
      await savePsaConnection(psaType, fields);
      const conns = await getPsaConnections();
      setConnections(conns);
      setConnForm(connFormFor(psaType, conns.find((c) => c.psa_type === psaType)));
      toast.success(`Connected to ${psaName}`);
      runDiscovery(psaType, config.emailOverrides, config.clientLinks);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setConnSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setConfirmDisconnect(false);
    try {
      await deletePsaConnection(psaType);
      setConnections((cs) => cs.filter((c) => c.psa_type !== psaType));
      setDiscovery(null);
      setScheduleEnabled(false);
      setConnForm(connFormFor(psaType, undefined));
      setRightTab("connection");
      toast.success(`${psaName} disconnected and schedule turned off`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  // --- Run ---

  const handleRun = async (mode: "dry-run" | "live") => {
    setConfirmLive(false);
    if (!canRun) {
      toast.error(runBlockReason || "Finish the setup first.");
      return;
    }
    setRunning(mode);
    setResult(null);
    try {
      const id = dirty || !taskId ? await saveSettings() : taskId;
      const res = await runPsaRoleSync(id, mode);
      setResult({ mode: res.mode, status: res.status, startedAt: new Date().toISOString(), summary: res.summary, details: res.details });
      const s = res.summary;
      if (res.status === "success") {
        const segs = segmentOn ? `, ${mode === "live" ? s.segmentApplied || 0 : s.segmentPlanned || 0} segment change(s)` : "";
        toast.success(mode === "live" ? `Assigned ${s.applied || 0} account role(s)${segs}` : `Dry run: ${s.planned || 0} assignment(s) to make${segs}`);
      } else {
        toast.warning(`Finished with ${s.errors || 0} error(s). See the Errors tab.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  };

  // --- Render ---

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px] gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading PSA Role Sync…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="bg-card border border-border rounded-lg p-6 text-sm text-destructive flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {loadError}
      </div>
    );
  }

  const switchDialog = (
    <AlertDialog open={!!pendingSwitch} onOpenChange={(open) => !open && setPendingSwitch(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch to {pendingSwitch ? psaShortName(pendingSwitch) : ""}?</AlertDialogTitle>
          <AlertDialogDescription>
            Your {psaName} role mapping and email matches are cleared and the schedule is turned off. The saved {psaName} connection and
            run history are kept, and nothing already assigned in ScalePad changes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => pendingSwitch && applyPsa(pendingSwitch)}>Switch</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (!psaChosen || pickerOpen) {
    return (
      <>
        <PsaPicker
          current={psaChosen ? psaType : null}
          connections={connections}
          onPick={handlePick}
          onCancel={psaChosen ? () => setPickerOpen(false) : undefined}
        />
        {switchDialog}
      </>
    );
  }

  const leftBody = () => {
    if (!connection) return <EmptyRow>Connect {psaName} on the right to load its roles and members.</EmptyRow>;
    if (discovering && !discovery) {
      return (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading {psaName} and ScalePad data…
        </div>
      );
    }
    if (discoverError) {
      return (
        <div className="p-4 text-[11px] text-destructive flex items-start gap-1.5">
          <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {discoverError}
        </div>
      );
    }
    if (!discovery) return null;

    if (leftTab === "fields") {
      return (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto">
            {fieldsPaged.rows.length === 0 ? (
              <EmptyRow>No ConnectWise company custom fields found.</EmptyRow>
            ) : (
              fieldsPaged.rows.map((f) => {
                const use = fieldUse(f);
                const asRole = !!use && use !== USE_SEGMENT;
                const unmatched = f.values.filter((v) => v.status !== "matched").length;
                return (
                  <div key={f.id} className="px-4 py-2.5 border-b border-border space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground truncate">{f.caption}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {f.values.length ? `${f.values.length} different value(s) on linked clients` : "No values on linked clients"}
                          {asRole && unmatched ? ` · ${unmatched} not matched` : ""}
                        </p>
                      </div>
                      <select
                        value={use}
                        onChange={(e) => setFieldUse(f, e.target.value)}
                        disabled={creatingRoles}
                        className={`${selectClass} w-44 shrink-0 ${use ? "border-primary/60" : ""}`}
                      >
                        <option value="">Don't sync</option>
                        <option value={USE_SEGMENT}>
                          Client segment{config.segmentFieldId && config.segmentFieldId !== f.id ? " (moves from other field)" : ""}
                        </option>
                        <optgroup label="Account team role">
                          {discovery.csRoles.map((r) => (
                            <option key={r.id} value={r.id}>{r.label}</option>
                          ))}
                          {!csRoleNamed(f.caption) && <option value={CREATE_ROLE}>+ Create "{f.caption}" in ScalePad</option>}
                        </optgroup>
                      </select>
                    </div>
                    {use && f.values.length > 0 && (
                      <div className="rounded-md border border-border bg-surface-raised max-h-64 overflow-y-auto">
                        {f.values.map((v) => (
                          <div key={v.key} className="px-3 py-1.5 border-b border-border last:border-b-0 space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[11px] text-foreground truncate">
                                {v.value} <span className="text-muted-foreground">({v.count})</span>
                              </span>
                              {use === USE_SEGMENT ? (
                                <select
                                  value={config.segmentMap[v.key] || ""}
                                  onChange={(e) => setSegmentForValue(v.key, e.target.value)}
                                  className={`${selectClass} w-36 shrink-0 ${config.segmentMap[v.key] ? "border-primary/60" : "border-warning"}`}
                                >
                                  <option value="">Don't change</option>
                                  {discovery.segments.map((seg) => (
                                    <option key={seg.id} value={seg.id}>{seg.label}</option>
                                  ))}
                                </select>
                              ) : v.status === "matched" ? (
                                <Badge className="bg-success/15 text-success">{v.via === "override" ? "Matched (override)" : "Matched"}</Badge>
                              ) : v.status === "inactive" ? (
                                <Badge className="bg-muted text-muted-foreground">Inactive</Badge>
                              ) : (
                                <Badge className="bg-warning/15 text-warning">{v.memberName ? "No ScalePad user" : "Not matched"}</Badge>
                              )}
                            </div>
                            {asRole && v.status === "matched" && (
                              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                <span className="truncate">
                                  {v.memberName ? `${v.memberName} → ` : "→ "}
                                  {v.csEmail}
                                </span>
                                {v.via === "override" && !v.memberName && (
                                  <button onClick={() => removeValueOverride(v.key)} className="hover:text-destructive flex items-center gap-0.5">
                                    <X className="w-3 h-3" /> Remove
                                  </button>
                                )}
                              </div>
                            )}
                            {asRole && v.status === "unmatched" && (
                              <>
                                <p className="text-[10px] text-muted-foreground">
                                  {v.ambiguous
                                    ? `Several ${psaName} members share this name.`
                                    : v.memberName
                                      ? `${v.memberName} has no matching ScalePad user.`
                                      : `Doesn't match a ${psaName} member's name, login or email.`}
                                </p>
                                <div className="flex gap-1.5">
                                  <input
                                    type="email"
                                    placeholder="ScalePad email for this value"
                                    value={overrideDrafts[`value:${v.key}`] || ""}
                                    onChange={(e) => setOverrideDrafts((d) => ({ ...d, [`value:${v.key}`]: e.target.value }))}
                                    onKeyDown={(e) => e.key === "Enter" && addValueOverride(v.key)}
                                    className={`${inputClass} h-7 text-[11px]`}
                                  />
                                  <button
                                    onClick={() => addValueOverride(v.key)}
                                    disabled={!(overrideDrafts[`value:${v.key}`] || "").trim()}
                                    className="text-[11px] px-2 rounded-md bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40"
                                  >
                                    Match
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <Pagination page={fieldsPaged.page} totalPages={fieldsPaged.totalPages} onPageChange={fieldsPaged.setPage} />
        </div>
      );
    }

    if (leftTab === "clients") {
      const listId = "psa-company-options";
      return (
        <div className="flex-1 flex flex-col min-h-0">
          <datalist id={listId}>
            {discovery.psaCompanies.map((c) => (
              <option key={c.id} value={companyLabel(c)} />
            ))}
          </datalist>
          <div className="flex-1 overflow-y-auto">
            {discovery.clients.manual.length > 0 && (
              <div className="border-b border-border">
                <p className="px-4 pt-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Linked by hand</p>
                {discovery.clients.manual.map((m) => (
                  <div key={m.clientId} className="flex items-center justify-between gap-2 px-4 py-1.5">
                    <div className="min-w-0">
                      <p className="text-xs text-foreground truncate">{m.clientName}</p>
                      <p className="text-[10px] text-muted-foreground truncate">→ {m.companyName}</p>
                    </div>
                    <button onClick={() => unlinkClient(m.clientId)} className="text-[10px] text-muted-foreground hover:text-destructive flex items-center gap-0.5 shrink-0">
                      <X className="w-3 h-3" /> Unlink
                    </button>
                  </div>
                ))}
              </div>
            )}
            {unlinkedPaged.rows.length === 0 ? (
              <EmptyRow>{discovery.clients.unlinked.length ? "No clients match." : `Every ScalePad client is linked to a ${psaName} company.`}</EmptyRow>
            ) : (
              unlinkedPaged.rows.map((c) => (
                <div key={c.id} className="px-4 py-2.5 border-b border-border space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-foreground truncate">{c.name}</p>
                    <Badge className="bg-warning/15 text-warning">Not linked</Badge>
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      list={listId}
                      placeholder={`Type to find the ${psaName} company`}
                      value={linkDrafts[c.id] || ""}
                      onChange={(e) => setLinkDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && linkClient(c.id)}
                      className={`${inputClass} h-7 text-[11px]`}
                    />
                    <button
                      onClick={() => linkClient(c.id)}
                      disabled={!companyByLabel.has((linkDrafts[c.id] || "").trim())}
                      className="text-[11px] px-2 rounded-md bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 flex items-center gap-1"
                    >
                      <Link2 className="w-3 h-3" /> Link
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          <Pagination page={unlinkedPaged.page} totalPages={unlinkedPaged.totalPages} onPageChange={unlinkedPaged.setPage} />
        </div>
      );
    }

    if (leftTab === "roles") {
      return (
        <>
          <div className="flex items-center justify-between gap-2 px-4 py-1.5 border-b border-border bg-surface-raised">
            <div className="flex items-center gap-2">
              <Checkbox checked={allRolesOnPageChecked} onCheckedChange={toggleRolePage} className="h-3.5 w-3.5" />
              <span className="text-[10px] text-muted-foreground">Select all on page</span>
            </div>
            {checkedRoleIds.size > 0 && (
              <button
                onClick={() => openCreateDialog([...checkedRoleIds])}
                disabled={creatingRoles}
                className="text-[11px] bg-primary/15 text-primary hover:bg-primary/25 px-2 py-0.5 rounded-md font-medium flex items-center gap-1 disabled:opacity-40"
              >
                {creatingRoles ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                Create in ScalePad ({checkedRoleIds.size})
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {rolesPaged.rows.length === 0 ? (
              <EmptyRow>No {psaName} roles found.</EmptyRow>
            ) : (
              rolesPaged.rows.map((role) => (
                <div key={role.id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border">
                  <div className="flex items-center gap-2 min-w-0">
                    <Checkbox checked={checkedRoleIds.has(role.id)} onCheckedChange={() => toggleRoleCheck(role.id)} className="h-3.5 w-3.5" />
                    <span className="text-xs font-medium text-foreground truncate">{role.name}</span>
                  </div>
                  <select
                    value={config.roleMap[role.id] || ""}
                    onChange={(e) => setRoleMapping(role.id, e.target.value)}
                    disabled={creatingRoles}
                    className={`${selectClass} w-44 shrink-0 ${config.roleMap[role.id] ? "border-primary/60" : ""}`}
                  >
                    <option value="">Don't sync</option>
                    {discovery.csRoles.map((r) => (
                      <option key={r.id} value={r.id}>{r.label}</option>
                    ))}
                    {!csRoleNamed(role.name) && <option value={CREATE_ROLE}>+ Create "{role.name}" in ScalePad</option>}
                  </select>
                </div>
              ))
            )}
          </div>
          <Pagination page={rolesPaged.page} totalPages={rolesPaged.totalPages} onPageChange={rolesPaged.setPage} />
        </>
      );
    }

    return (
      <>
        <div className="flex-1 overflow-y-auto">
          {membersPaged.rows.length === 0 ? (
            <EmptyRow>No members match.</EmptyRow>
          ) : (
            membersPaged.rows.map((m) => (
              <div key={m.id} className="px-4 py-2.5 border-b border-border space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{m.name || m.identifier}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{m.email || `No email in ${psaName}`}</p>
                  </div>
                  {m.status === "matched" ? (
                    <Badge className="bg-success/15 text-success">{m.via === "override" ? "Matched (override)" : "Matched"}</Badge>
                  ) : m.status === "inactive" ? (
                    <Badge className="bg-muted text-muted-foreground">Inactive</Badge>
                  ) : (
                    <Badge className="bg-warning/15 text-warning">No ScalePad user</Badge>
                  )}
                </div>
                {m.status === "matched" && m.via === "override" && (
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span className="truncate">→ {m.csEmail}</span>
                    <button onClick={() => removeOverride(m)} className="hover:text-destructive flex items-center gap-0.5">
                      <X className="w-3 h-3" /> Remove
                    </button>
                  </div>
                )}
                {m.status === "unmatched" && (
                  <div className="flex gap-1.5">
                    <input
                      type="email"
                      placeholder="ScalePad email for this person"
                      value={overrideDrafts[m.id] || ""}
                      onChange={(e) => setOverrideDrafts((d) => ({ ...d, [m.id]: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && addOverride(m)}
                      className={`${inputClass} h-7 text-[11px]`}
                    />
                    <button
                      onClick={() => addOverride(m)}
                      disabled={!(overrideDrafts[m.id] || "").trim()}
                      className="text-[11px] px-2 rounded-md bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40"
                    >
                      Match
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
        <Pagination page={membersPaged.page} totalPages={membersPaged.totalPages} onPageChange={membersPaged.setPage} />
      </>
    );
  };

  const connectionFields = psa.fields.map((field) => {
    if (psaType === "connectwise" && field.key === "site") {
      return (
        <div key="site" className="contents">
          <Field label="Site">
            <select value={connForm.site} onChange={(e) => setConnForm((f) => ({ ...f, site: e.target.value }))} className={`${selectClass} w-full h-8`}>
              {CW_SITES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
              <option value="custom">Other / on-premises</option>
            </select>
          </Field>
          {connForm.site === "custom" ? (
            <Field label="Site host" hint="Host name only, for example cw.yourcompany.com">
              <input value={connForm.customSite || ""} onChange={(e) => setConnForm((f) => ({ ...f, customSite: e.target.value }))} className={inputClass} />
            </Field>
          ) : (
            <div />
          )}
        </div>
      );
    }
    return (
      <Field
        key={field.key}
        label={field.label}
        hint={field.secret ? (connection ? "Leave blank to keep the saved value" : "Stored encrypted; never shown again") : field.hint}
      >
        <input
          type={field.secret ? "password" : "text"}
          autoComplete={field.secret ? "new-password" : "off"}
          placeholder={field.secret && connection ? "••••••••" : ""}
          value={connForm[field.key] || ""}
          onChange={(e) => setConnForm((f) => ({ ...f, [field.key]: e.target.value }))}
          className={inputClass}
        />
      </Field>
    );
  });

  const connectionSummary = () => {
    if (!connection) return "Not connected";
    const who = { connectwise: connection.settings.companyId, autotask: connection.settings.username, halo: (connection.settings.url || "").replace(/^https:\/\//, "") }[psaType];
    const clients = discovery ? `${discovery.clients.linked} of ${discovery.clients.total} clients linked` : "connected";
    return `${psaName} ${who || ""} · ${clients}`;
  };

  return (
    <>
      <div className="flex gap-4 min-h-[600px]">
        {/* LEFT PANEL: mapping and member matches */}
        <div className="w-[40%] flex flex-col bg-card border border-border rounded-lg overflow-hidden">
          <div className="p-4 border-b border-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="font-heading font-bold text-sm text-foreground">{psaName} Roles</h3>
                {discovery && <Badge className="bg-primary/15 text-primary">{mappedCount + (segmentOn ? 1 : 0)} mapped</Badge>}
              </div>
              {connection && (
                <button
                  onClick={() => runDiscovery(psaType, config.emailOverrides, config.clientLinks)}
                  disabled={discovering}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-40"
                >
                  <RefreshCw className={`w-3 h-3 ${discovering ? "animate-spin" : ""}`} /> Refresh
                </button>
              )}
            </div>
            {discovery && (
              <>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  {leftTab === "roles" ? (
                    <input type="text" placeholder="Search roles…" value={roleSearch} onChange={(e) => setRoleSearch(e.target.value)} className={`${inputClass} pl-8`} />
                  ) : leftTab === "fields" ? (
                    <input type="text" placeholder="Search custom fields…" value={fieldSearch} onChange={(e) => setFieldSearch(e.target.value)} className={`${inputClass} pl-8`} />
                  ) : leftTab === "clients" ? (
                    <input type="text" placeholder="Search unlinked clients…" value={clientSearch} onChange={(e) => setClientSearch(e.target.value)} className={`${inputClass} pl-8`} />
                  ) : (
                    <input type="text" placeholder="Search members…" value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} className={`${inputClass} pl-8`} />
                  )}
                </div>
                {leftTab === "roles" ? (
                  <p className="text-[10px] text-muted-foreground">{psa.roleHelp}</p>
                ) : leftTab === "fields" ? (
                  <p className="text-[10px] text-muted-foreground">
                    Use a company custom field as an account role (its value names a person) or as the client segment (each value maps to a
                    segment). A blank value never changes anything. Role fields rank after the team roles when one person holds two.
                  </p>
                ) : leftTab === "clients" ? (
                  <p className="text-[10px] text-muted-foreground">
                    {discovery.clients.linked} of {discovery.clients.total} ScalePad clients are linked to a {psaName} company. Link the rest by
                    hand so the sync can update them; your {psaName} integration links most clients on its own.
                  </p>
                ) : (
                  <div className="flex items-center gap-2">
                    <select value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)} className={`${selectClass} flex-1`}>
                      {MEMBER_FILTERS.map((f) => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                      {memberCounts.matched} matched · {memberCounts.unmatched} unmatched
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
          {discovery && (
            <TabBar<typeof leftTab>
              tabs={[
                ["roles", `Roles (${discovery.psaRoles.length})`],
                ["members", `Members (${discovery.members.length})`],
                ...(psaType === "connectwise" ? ([["fields", `Fields (${discovery.customFields.length})`]] as [typeof leftTab, string][]) : []),
                ["clients", `Unlinked (${discovery.clients.unlinked.length})`],
              ]}
              active={leftTab}
              onChange={setLeftTab}
            />
          )}
          {discovery && discovery.warnings.length > 0 && (
            <div className="px-4 py-2 border-b border-border text-[10px] text-warning space-y-0.5">
              {discovery.warnings.map((w) => (
                <p key={w} className="flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {w}</p>
              ))}
            </div>
          )}
          {leftBody()}
        </div>

        {/* RIGHT PANEL: connection, run, history */}
        <div className="w-[60%] flex flex-col bg-card border border-border rounded-lg overflow-hidden">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-heading font-bold text-sm text-foreground">PSA Role Sync</h3>
                <button
                  onClick={() => setPickerOpen(true)}
                  className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  <ArrowLeftRight className="w-3 h-3" /> Change PSA
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">{connectionSummary()}</p>
            </div>
            <div className="flex items-center gap-2">
              {dirty && <span className="text-[10px] text-warning">Unsaved changes</span>}
              <button
                onClick={handleSave}
                disabled={saving || !connection}
                className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save settings
              </button>
            </div>
          </div>

          <TabBar<typeof rightTab>
            tabs={[
              ["connection", "Connection"],
              ["run", "Schedule & Run"],
              ["history", "History"],
            ]}
            active={rightTab}
            onChange={setRightTab}
          />

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {rightTab === "connection" && (
              <>
                <div className="flex items-center gap-2 text-xs">
                  {connection ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-success" />
                      <span className="text-foreground">
                        Connected to {psaName}
                        {connection.verified_at ? `, verified ${new Date(connection.verified_at).toLocaleString()}` : ""}
                      </span>
                    </>
                  ) : (
                    <>
                      <Plug className="w-4 h-4 text-muted-foreground" />
                      <span className="text-muted-foreground">Add your {psaName} API details to get started.</span>
                    </>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">{connectionFields}</div>
                <p className="text-[10px] text-muted-foreground">{psa.accessHelp}</p>
                <div className="flex items-center justify-between">
                  <button
                    onClick={handleSaveConnection}
                    disabled={connSaving}
                    className="h-8 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium flex items-center gap-1.5 hover:bg-primary/90 disabled:opacity-50"
                  >
                    {connSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
                    {connection ? "Update and test" : "Connect and test"}
                  </button>
                  {connection && (
                    <button onClick={() => setConfirmDisconnect(true)} className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1">
                      <Trash2 className="w-3 h-3" /> Disconnect
                    </button>
                  )}
                </div>
              </>
            )}

            {rightTab === "run" && (
              <>
                {!connection ? (
                  <EmptyRow>Connect {psaName} first.</EmptyRow>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="How often">
                        <select
                          value={config.syncIntervalDays}
                          onChange={(e) => updateConfig({ syncIntervalDays: Number(e.target.value) as PsaRoleSyncConfig["syncIntervalDays"] })}
                          className={`${selectClass} w-full h-8`}
                        >
                          {INTERVALS.map((i) => (
                            <option key={i.value} value={i.value}>{i.label}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Scheduled sync" hint={scheduleEnabled ? "Runs live automatically" : "Off: runs only when you start them"}>
                        <div className="h-8 flex items-center">
                          <Switch checked={scheduleEnabled} onCheckedChange={handleScheduleToggle} disabled={saving} />
                        </div>
                      </Field>
                    </div>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <Checkbox
                        checked={config.overwriteRoles}
                        onCheckedChange={(v) => updateConfig({ overwriteRoles: v === true })}
                        className="h-3.5 w-3.5 mt-0.5"
                      />
                      <span className="text-[11px] text-foreground">
                        Replace a different role already set in ScalePad
                        <span className="block text-[10px] text-muted-foreground">
                          Off: those are skipped and listed as "Different role in ScalePad". The sync never removes anyone either way.
                        </span>
                      </span>
                    </label>
                    <Field
                      label="Clients to sync"
                      hint={scopeSelected ? "Only the clients you tick below are synced, scheduled runs included. Links aren't changed." : undefined}
                    >
                      <select
                        value={config.syncScope}
                        onChange={(e) => updateConfig({ syncScope: e.target.value as PsaRoleSyncConfig["syncScope"] })}
                        className={`${selectClass} w-full h-8`}
                      >
                        <option value="all">All linked clients{discovery ? ` (${discovery.clients.linked})` : ""}</option>
                        <option value="selected">Only selected clients (test)</option>
                      </select>
                    </Field>
                    {scopeSelected && discovery?.scopeSupported && (
                      <div className="rounded-md border border-border">
                        <div className="p-2 border-b border-border space-y-1.5">
                          <div className="relative">
                            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                            <input
                              type="text"
                              placeholder="Search linked clients…"
                              value={scopeSearch}
                              onChange={(e) => setScopeSearch(e.target.value)}
                              className={`${inputClass} h-7 text-[11px] pl-8`}
                            />
                          </div>
                          {config.scopeClientIds.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {config.scopeClientIds.map((id) => (
                                <button
                                  key={id}
                                  onClick={() => toggleScopeClient(id, false)}
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary flex items-center gap-0.5 hover:bg-primary/25"
                                >
                                  {linkedNameById.get(id) || "Client no longer linked"} <X className="w-3 h-3" />
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        {scopePaged.rows.length === 0 ? (
                          <EmptyRow>{discovery.clients.linkedList.length ? "No clients match." : "No linked clients yet."}</EmptyRow>
                        ) : (
                          scopePaged.rows.map((c) => (
                            <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 border-b border-border last:border-b-0 cursor-pointer hover:bg-surface-raised">
                              <Checkbox
                                checked={config.scopeClientIds.includes(c.id)}
                                onCheckedChange={(v) => toggleScopeClient(c.id, v === true)}
                                className="h-3.5 w-3.5"
                              />
                              <span className="text-[11px] text-foreground truncate">{c.name}</span>
                            </label>
                          ))
                        )}
                        <Pagination page={scopePaged.page} totalPages={scopePaged.totalPages} onPageChange={scopePaged.setPage} />
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleRun("dry-run")}
                        disabled={!!running || !canRun}
                        className="h-8 px-4 rounded-md border border-border text-xs font-medium text-foreground flex items-center gap-1.5 hover:bg-surface-raised disabled:opacity-40"
                      >
                        {running === "dry-run" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />} Dry run
                      </button>
                      <button
                        onClick={() => setConfirmLive(true)}
                        disabled={!!running || !canRun}
                        className="h-8 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium flex items-center gap-1.5 hover:bg-primary/90 disabled:opacity-40"
                      >
                        {running === "live" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run live
                      </button>
                      {runBlockReason && <span className="text-[10px] text-muted-foreground">{runBlockReason}</span>}
                    </div>
                    {running && (
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                        <Loader2 className="w-3 h-3 animate-spin" />{" "}
                        {scopeSelected ? `Reading the selected clients' ${psaName} teams.` : `Reading every linked client's ${psaName} team. This can take a minute or two.`}
                      </p>
                    )}
                    {result && <RunResults result={result} psaName={psaName} />}
                  </>
                )}
              </>
            )}

            {rightTab === "history" && (
              <>
                {!taskId ? (
                  <EmptyRow>No runs yet.</EmptyRow>
                ) : runsLoading ? (
                  <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading runs…
                  </div>
                ) : runs.length === 0 ? (
                  <EmptyRow>No runs yet.</EmptyRow>
                ) : (
                  <div className="border border-border rounded-md overflow-hidden">
                    {runs.map((r) => {
                      const runPsa = (r.details as { psaType?: PsaType } | null)?.psaType;
                      return (
                        <button
                          key={r.id}
                          onClick={() => {
                            setResult({ mode: r.mode, status: r.status, startedAt: r.started_at, summary: r.summary, details: r.details || {}, error: r.error_message });
                            setRightTab("run");
                          }}
                          className="w-full flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border last:border-b-0 hover:bg-surface-raised text-left"
                        >
                          <div>
                            <p className="text-xs text-foreground">{new Date(r.started_at).toLocaleString()}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {runPsa ? `${psaShortName(runPsa)} · ` : ""}
                              {r.trigger_type === "scheduled" ? "Scheduled" : "Manual"} · {r.mode === "live" ? "Live" : "Dry run"}
                              {r.summary ? ` · ${r.mode === "live" ? r.summary.applied || 0 : r.summary.planned || 0} assignment(s)` : ""}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Badge className={STATUS_COLORS[r.status] || "bg-muted text-muted-foreground"}>{r.status}</Badge>
                            <ChevronRight className="w-3 h-3 text-muted-foreground" />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {switchDialog}

      <AlertDialog open={confirmLive} onOpenChange={setConfirmLive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run the sync live?</AlertDialogTitle>
            <AlertDialogDescription>
              {scopeSelected ? `This only touches the ${config.scopeClientIds.length} selected client(s). ` : ""}
              This assigns matched {psaName} team members to their ScalePad clients with the mapped account roles. It only adds assignments
              {config.overwriteRoles ? " and replaces different roles" : ""}; nobody is removed.
              {segmentOn ? " It also sets each client's segment from the mapped custom field, replacing the current segment; clients with a blank value are left alone." : ""}{" "}
              Run a dry run first if you haven't.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => handleRun("live")}>Run live</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!pendingCreate} onOpenChange={(open) => !open && setPendingCreate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create {createDialogIds.length === 1 ? "this role" : `${createDialogIds.length} roles`} in ScalePad?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  New account team roles are added to ScalePad CS with the same names as your {psaName} roles, and mapped here. Names that
                  already exist in ScalePad are reused, not duplicated. Existing roles aren't changed.
                </p>
                <ul className="list-disc pl-5 text-foreground">
                  {createDialogIds.slice(0, 12).map((id) => (
                    <li key={id}>
                      {psaRoleName(id)}
                      {csRoleNamed(psaRoleName(id)) ? " (already exists, will be mapped)" : ""}
                    </li>
                  ))}
                  {createDialogIds.length > 12 && <li>and {createDialogIds.length - 12} more</li>}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleCreateRoles}>Create</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {psaName}?</AlertDialogTitle>
            <AlertDialogDescription>
              The saved {psaName} API details are deleted and the schedule is turned off. Your role mapping and run history are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
