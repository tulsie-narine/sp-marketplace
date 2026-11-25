import { useEffect, useMemo, useRef, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Upload,
  XCircle,
} from "lucide-react";
import { controlMapClientFor } from "@/lib/controlmap-importer-api";
import { describeError, type CmClient, type ControlMapClient } from "@/lib/controlmap-importer/controlmap";
import { ROLES, ROLE_LABELS, MULTI_ROLES, pickSheet, detectHeaderRow, guessColumns, extractRecords } from "@/lib/controlmap-importer/columns";
import { CM_STATUSES, KEEP_STATUS, isResponseValue, normalizeResponse, responseSummary } from "@/lib/controlmap-importer/responses";
import { buildIndex, matchAll, toObjective, fitSummary } from "@/lib/controlmap-importer/objectives";
import { buildPlan, runLogCsv, TEXT_TARGETS } from "@/lib/controlmap-importer/plan";

// --- Constants ---

const PAGE_SIZE = 8;
const STEPS = [
  { id: 1, label: "Client & Framework" },
  { id: 2, label: "Upload File" },
  { id: 3, label: "Columns" },
  { id: 4, label: "Responses" },
  { id: 5, label: "Review Matches" },
  { id: 6, label: "Update ControlMap" },
] as const;
type Screen = (typeof STEPS)[number]["id"];

type Sheet = { name: string; rows: Array<Array<{ text: string; isNumber: boolean }>> };
type SourceRecord = ReturnType<typeof extractRecords>["records"][number];
type Match = ReturnType<typeof matchAll>["matches"][number];
type ObjectiveIndex = ReturnType<typeof buildIndex>;
type Plan = ReturnType<typeof buildPlan>;
type Update = Plan["updates"][number];
type UpdateResult = Update & { ok: boolean; error?: string };
type ReviewFilter = "review" | "accepted" | "duplicates" | "skipped" | "all";

const BAND_LABELS: Record<string, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence", none: "No match" };
const BAND_COLORS: Record<string, string> = {
  high: "bg-success/15 text-success",
  medium: "bg-warning/15 text-warning",
  low: "bg-destructive/15 text-destructive",
  none: "bg-muted text-muted-foreground",
};

const inputClass =
  "w-full h-8 px-3 bg-surface-raised border border-border rounded-md text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary";
const selectClass = "h-8 px-2 bg-surface-raised border border-border rounded text-xs text-foreground focus:outline-none disabled:opacity-50";
const primaryButton =
  "inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed";
const secondaryButton =
  "inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed";
const smallButton = "text-[11px] px-2 py-1 rounded border border-border text-foreground hover:bg-surface-raised disabled:opacity-40";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// --- Sub-components ---

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${className}`}>{children}</span>;
}

function StepIndicator({ current, reached, onGo, locked }: { current: Screen; reached: number; onGo: (s: Screen) => void; locked: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        {STEPS.map((step, index) => {
          const clickable = !locked && step.id !== current && step.id <= reached;
          return (
            <div key={step.id} className="flex items-center gap-3">
              <button type="button" disabled={!clickable} onClick={() => onGo(step.id)} className="flex items-center gap-2 disabled:cursor-default">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold ${
                    current === step.id
                      ? "border-primary bg-primary/15 text-primary"
                      : current > step.id
                        ? "border-success bg-success/10 text-success"
                        : "border-border bg-surface-raised text-muted-foreground"
                  }`}
                >
                  {step.id}
                </div>
                <span className={`text-xs font-medium ${current === step.id ? "text-foreground" : "text-muted-foreground"} ${clickable ? "hover:text-foreground" : ""}`}>
                  {step.label}
                </span>
              </button>
              {index < STEPS.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Panel({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div>
        <h3 className="font-heading font-bold text-base text-foreground">{title}</h3>
        {description && <p className="text-xs text-muted-foreground mt-1 max-w-3xl">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: "ok" | "warn" | "primary" }) {
  const color = tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : tone === "primary" ? "text-primary" : "text-foreground";
  return (
    <div className="rounded-md border border-border bg-surface-raised px-4 py-3 min-w-[120px]">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
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

/** Search box over every objective in the framework, closest matches for this row first. */
function ObjectivePicker({ index, match, onPick }: { index: ObjectiveIndex; match: Match; onPick: (id: number) => void }) {
  const listId = useMemo(() => `cm-objectives-${Math.random().toString(36).slice(2)}`, []);
  const { options, byLabel } = useMemo(() => {
    const label = (o: { code: string; name: string }) => `${o.code} - ${o.name}`.slice(0, 120);
    const alt = match.alternatives.map((a) => index.byId.get(a.objectiveId)).filter(Boolean);
    const altSet = new Set(alt);
    const all = [...index.objectives].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    const ordered = [...alt, ...all.filter((o) => !altSet.has(o))];
    return { options: ordered.map(label), byLabel: new Map(ordered.map((o) => [label(o), o])) };
  }, [index, match]);
  return (
    <div className="mt-2">
      <input
        autoFocus
        type="search"
        list={listId}
        placeholder="Type an ID or words from the objective"
        aria-label="Search ControlMap objectives"
        className={inputClass}
        onChange={(e) => {
          const o = byLabel.get(e.target.value);
          if (o) onPick(o.id);
        }}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </div>
  );
}

// --- Main workspace ---

export function CmAssessmentImporterWorkspace() {
  const apiKey = sessionStorage.getItem("sp_api_key") || "";
  const hasRealKey = !!apiKey && apiKey !== "admin-key";
  const cm = useMemo<ControlMapClient | null>(() => (hasRealKey ? controlMapClientFor(apiKey) : null), [apiKey, hasRealKey]);

  const rootRef = useRef<HTMLDivElement>(null);
  const [screen, setScreen] = useState<Screen>(1);
  const [reached, setReached] = useState(1);

  // Step 1
  const [clients, setClients] = useState<CmClient[]>([]);
  const [loadingClients, setLoadingClients] = useState(false);
  const [clientsError, setClientsError] = useState("");
  const [clientId, setClientId] = useState("");
  const [frameworkId, setFrameworkId] = useState(0);
  const [index, setIndex] = useState<ObjectiveIndex | null>(null);
  const [loadingObjectives, setLoadingObjectives] = useState("");

  // Step 2 and 3
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState("");
  const [readingFile, setReadingFile] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [headers, setHeaders] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [columnError, setColumnError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  // Step 4
  const [statusChoices, setStatusChoices] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState({ notes: "implementation_details", evidence: "implementation_details" });

  // Step 5
  const [matches, setMatches] = useState<Match[]>([]);
  const [accepted, setAccepted] = useState<(number | null)[]>([]);
  const [skippedRows, setSkippedRows] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<ReviewFilter>("review");
  const [search, setSearch] = useState("");
  const [pickerRow, setPickerRow] = useState<number | null>(null);
  const [confirmBulk, setConfirmBulk] = useState<{ total: number; weak: number } | null>(null);

  // Step 6
  const [rollUp, setRollUp] = useState(true);
  const [showPlan, setShowPlan] = useState(false);
  const [results, setResults] = useState<UpdateResult[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [confirmRun, setConfirmRun] = useState(false);

  const client = clients.find((c) => c.id === clientId);
  const framework = client?.frameworks.find((f) => f.id === frameworkId);
  const sheet = sheets[sheetIdx];

  const go = (s: Screen) => {
    setScreen(s);
    setReached((r) => Math.max(r, s));
    // Keep the step bar in view rather than jumping to the top of the app page.
    requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  // --- Step 1: clients and frameworks ---

  const loadClients = async () => {
    if (!cm) return;
    setLoadingClients(true);
    setClientsError("");
    try {
      setClients(await cm.listClients());
    } catch (e) {
      setClientsError(describeError(e));
    } finally {
      setLoadingClients(false);
    }
  };

  useEffect(() => {
    loadClients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cm]);

  const clientsWithFrameworks = clients.filter((c) => c.frameworks.length);
  const hiddenClients = clients.length - clientsWithFrameworks.length;

  const loadObjectives = async () => {
    if (!cm || !clientId || !frameworkId) return;
    setLoadingObjectives("Loading objectives...");
    try {
      const raw = await cm.listObjectives(clientId, frameworkId, (n, total) => setLoadingObjectives(`Loading objectives ${n} of ${total}...`));
      if (!raw.length) throw new Error("This framework has no objectives for this client.");
      setIndex(buildIndex(raw.map(toObjective)));
      setMatches([]); // a new catalog invalidates earlier matches
      go(records.length ? 3 : 2);
    } catch (e) {
      toast.error(`Couldn't load objectives: ${describeError(e)}`);
    } finally {
      setLoadingObjectives("");
    }
  };

  // --- Step 2: file ---

  const applyColumns = (s: Sheet, row: number) => {
    const g = guessColumns(s, row, { isResponseValue });
    setHeaderRow(row);
    setHeaders(g.headers);
    setRoles(g.roles);
    setMatches([]);
  };

  const selectSheet = (all: Sheet[], i: number) => {
    setSheetIdx(i);
    applyColumns(all[i], detectHeaderRow(all[i]));
  };

  const loadFile = async (file: File) => {
    setReadingFile(true);
    setFileError("");
    try {
      // The spreadsheet reader is large, so it only loads when a file is chosen.
      const { parseWorkbook } = await import("@/lib/controlmap-importer/workbook");
      const parsed: Sheet[] = parseWorkbook(await file.arrayBuffer(), file.name);
      if (!parsed.length) throw new Error("The file has no data in it.");
      setFileName(file.name);
      setSheets(parsed);
      setStatusChoices({});
      setResults([]);
      selectSheet(parsed, pickSheet(parsed));
    } catch (e) {
      setFileName("");
      setSheets([]);
      setFileError(`We couldn't read that file. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReadingFile(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  // --- Step 3: columns ---

  const { records, skipped } = useMemo(
    () => (sheet && roles.length ? extractRecords(sheet, headerRow, roles, headers) : { records: [] as SourceRecord[], skipped: [] }),
    [sheet, headerRow, roles, headers],
  );

  const setRole = (col: number, role: string) => {
    setRoles((prev) => {
      // Single-use roles move: picking "Objective ID" here clears it elsewhere.
      const next = !MULTI_ROLES.has(role) && role !== "ignore" ? prev.map((r, i) => (r === role && i !== col ? "ignore" : r)) : [...prev];
      next[col] = role;
      return next;
    });
    setMatches([]);
    setColumnError("");
  };

  const continueFromColumns = () => {
    const has = (r: string) => roles.includes(r);
    if (!has("code") && !has("title") && !has("description"))
      return setColumnError("Choose at least one column with the objective ID, name or description, so we can find the matching objective.");
    if (!has("response") && !has("notes") && !has("evidence")) return setColumnError("Choose the column with the responses (or notes or evidence) to import.");
    if (!records.length) return setColumnError("No answer rows were found with these settings. Check the header row and the response column.");
    setColumnError("");
    go(4);
  };

  // --- Step 4: responses ---

  const summary = useMemo(() => responseSummary(records), [records]);

  useEffect(() => {
    if (screen !== 4) return;
    setStatusChoices((prev) => {
      const next = { ...prev };
      for (const s of summary) {
        const k = normalizeResponse(s.value);
        if (!(k in next) && s.suggested) next[k] = s.suggested;
      }
      return next;
    });
  }, [screen, summary]);

  const unmappedResponses = summary.filter((s) => !statusChoices[normalizeResponse(s.value)]);
  const hasNotes = roles.includes("notes");
  const hasEvidence = roles.includes("evidence");

  const continueFromResponses = () => {
    if (unmappedResponses.length) {
      toast.error(`Choose a ControlMap status for: ${unmappedResponses.map((m) => m.value || "(blank)").join(", ")}`);
      return;
    }
    if (!matches.length && index) {
      const found = matchAll(records, index).matches;
      setMatches(found);
      // Only confident matches are accepted without the partner looking.
      setAccepted(found.map((m) => (m.band === "high" ? m.objectiveId : null)));
      setSkippedRows(new Set());
      setFilter(found.some((m) => m.band !== "high") ? "review" : "accepted");
      setSearch("");
      setPickerRow(null);
    }
    go(5);
  };

  // --- Step 5: review ---

  const rowState = (i: number): "review" | "accepted" | "skipped" => (skippedRows.has(i) ? "skipped" : accepted[i] != null ? "accepted" : "review");

  const duplicates = useMemo(() => {
    const claims = new Map<number, number[]>();
    accepted.forEach((id, i) => id != null && !skippedRows.has(i) && claims.set(id, [...(claims.get(id) ?? []), i]));
    const dup = new Map<number, number[]>();
    for (const rows of claims.values()) if (rows.length > 1) for (const i of rows) dup.set(i, rows.filter((r) => r !== i));
    return dup;
  }, [accepted, skippedRows]);

  const counts = useMemo(() => {
    const c = { review: 0, accepted: 0, skipped: 0 };
    for (let i = 0; i < matches.length; i++) c[rowState(i)]++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, accepted, skippedRows]);

  const fit = useMemo(() => fitSummary(matches), [matches]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out: number[] = [];
    for (let i = 0; i < matches.length; i++) {
      const s = rowState(i);
      if (!(filter === "all" || filter === s || (filter === "duplicates" && duplicates.has(i)))) continue;
      if (q) {
        const r = records[i];
        const target = index?.byId.get(accepted[i] ?? matches[i].objectiveId);
        const hay = `${r.code} ${r.title} ${r.description} ${r.response} ${target?.code ?? ""} ${target?.name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push(i);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, accepted, skippedRows, filter, search, duplicates, records, index]);

  const reviewPage = usePaged(visibleRows, `${filter}|${search}`);

  const setAcceptedAt = (i: number, id: number | null) => setAccepted((prev) => prev.map((v, j) => (j === i ? id : v)));
  const setSkipped = (i: number, skip: boolean) =>
    setSkippedRows((prev) => {
      const next = new Set(prev);
      if (skip) next.add(i);
      else next.delete(i);
      return next;
    });

  const pendingSuggestions = matches.filter((m, i) => rowState(i) === "review" && m.objectiveId != null);
  const pendingUnmatched = matches.filter((m, i) => rowState(i) === "review" && m.objectiveId == null).length;

  const acceptAllSuggestions = (confirmed = false) => {
    // Accepting a pile of weak guesses in one click is how wrong data gets into
    // ControlMap, so say how many are low confidence and make the partner confirm.
    const weak = pendingSuggestions.filter((m) => m.band === "low").length;
    if (!confirmed && weak > 0 && weak / pendingSuggestions.length >= 0.25) {
      setConfirmBulk({ total: pendingSuggestions.length, weak });
      return;
    }
    setAccepted((prev) => prev.map((id, i) => (rowState(i) === "review" && matches[i].objectiveId != null ? matches[i].objectiveId : id)));
    toast.success(`Accepted ${plural(pendingSuggestions.length, "suggestion")}`);
  };

  const skipUnmatched = () => {
    setSkippedRows((prev) => {
      const next = new Set(prev);
      matches.forEach((m, i) => rowState(i) === "review" && m.objectiveId == null && next.add(i));
      return next;
    });
  };

  const acceptedCount = accepted.filter((id, i) => id != null && !skippedRows.has(i)).length;

  // --- Step 6: update ---

  const decisions = useMemo(() => accepted.map((id, i) => (skippedRows.has(i) ? null : id)), [accepted, skippedRows]);
  const answersChildren = !!index && decisions.some((id) => id != null && index.byId.get(id)?.isChild);

  const plan: Plan | null = useMemo(() => {
    if (!index || screen !== 6) return null;
    return buildPlan({
      records,
      decisions,
      statusChoices,
      targets: { notes: hasNotes ? targets.notes : "none", evidence: hasEvidence ? targets.evidence : "none" },
      rollUp: rollUp && answersChildren,
      fileName,
      index,
    });
  }, [index, screen, records, decisions, statusChoices, hasNotes, hasEvidence, targets, rollUp, answersChildren, fileName]);

  const updates = plan?.updates ?? [];
  const statusChanges = updates.filter((u) => u.body.status && u.body.status !== u.statusBefore).length;
  const withText = updates.filter((u) => u.body.implementation_details || u.body.remarks).length;
  const notImported = decisions.filter((d) => d == null).length;
  const failed = results.filter((r) => !r.ok);
  const planPage = usePaged(updates, plan);

  const runUpdates = async (batch: Update[], earlier: UpdateResult[]) => {
    if (!cm || !index) return;
    setRunning(true);
    setProgress({ done: 0, total: batch.length });
    const lock = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", lock);
    const latest = [...earlier];
    let done = 0;
    for (const u of batch) {
      let res: UpdateResult;
      try {
        await cm.updateObjective(clientId, frameworkId, u.objectiveId, u.body);
        res = { ...u, ok: true };
        const o = index.byId.get(u.objectiveId);
        if (o && u.body.status) o.status = u.body.status;
      } catch (e) {
        res = { ...u, ok: false, error: describeError(e) };
      }
      const prev = latest.findIndex((r) => r.objectiveId === u.objectiveId);
      if (prev >= 0) latest[prev] = res;
      else latest.push(res);
      setResults([...latest]);
      done++;
      setProgress({ done, total: batch.length });
    }
    window.removeEventListener("beforeunload", lock);
    setRunning(false);
    const bad = latest.filter((r) => !r.ok).length;
    if (bad) toast.error(`${plural(bad, "objective")} couldn't be updated. The reasons are listed below.`);
    else toast.success(`ControlMap is updated: ${plural(latest.length, "objective")}`);
  };

  const downloadLog = () => {
    const blob = new Blob([runLogCsv(results)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `controlmap-import-${fileName.replace(/\.\w+$/, "")}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const startOver = () => {
    setFileName("");
    setSheets([]);
    setHeaders([]);
    setRoles([]);
    setMatches([]);
    setAccepted([]);
    setSkippedRows(new Set());
    setResults([]);
    setStatusChoices({});
    setProgress({ done: 0, total: 0 });
    setReached(2);
    go(2);
  };

  // --- Render ---

  if (!hasRealKey) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
        Sign in with a ScalePad API key to use the ControlMap Assessment Importer. The key needs read and write access to ControlMap.
      </div>
    );
  }

  const backButton = (to: Screen) => (
    <button onClick={() => go(to)} disabled={running} className={secondaryButton}>
      <ArrowLeft className="h-4 w-4" /> Back
    </button>
  );

  const renderClientStep = () => (
    <Panel
      title="Choose the client and framework"
      description="Bring a completed compliance assessment from any tool or spreadsheet into ControlMap. Pick the client it belongs to and the framework it should update. We match each answer to a ControlMap objective, you review the matches, and then we update status, notes and evidence details."
    >
      {loadingClients ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading ControlMap clients...
        </div>
      ) : clientsError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive flex items-center justify-between gap-3">
          <span>Couldn't load ControlMap clients: {clientsError}</span>
          <button onClick={loadClients} className={smallButton}>
            <RefreshCw className="h-3 w-3 inline mr-1" /> Retry
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            <label className="text-xs text-muted-foreground space-y-1">
              <span>Client</span>
              <select
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setFrameworkId(0);
                }}
                className={`${selectClass} block w-72`}
              >
                <option value="">Choose a client</option>
                {clientsWithFrameworks.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted-foreground space-y-1">
              <span>Framework</span>
              <select
                value={frameworkId ? String(frameworkId) : ""}
                onChange={(e) => setFrameworkId(Number(e.target.value) || 0)}
                disabled={!client}
                className={`${selectClass} block w-72`}
              >
                <option value="">{client ? "Choose a framework" : "Choose a client first"}</option>
                {client?.frameworks.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </label>
          </div>
          {hiddenClients > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {plural(hiddenClients, "client has", "clients have")} no frameworks enabled in ControlMap and {hiddenClients === 1 ? "isn't" : "aren't"} listed.
            </p>
          )}
          {!clients.length && <p className="text-[11px] text-muted-foreground">No ControlMap clients were found for this API key.</p>}
        </>
      )}
      <div className="rounded-md border border-border bg-surface-raised p-3 text-[11px] text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">How your data is handled</p>
        <p>Your file is read and matched in this browser. Only the updates you approve on the last step are sent to ScalePad, through the marketplace's ScalePad connection. Nothing from the file is stored.</p>
      </div>
      <div className="flex justify-end">
        <button onClick={loadObjectives} disabled={!clientId || !frameworkId || !!loadingObjectives} className={primaryButton}>
          {loadingObjectives ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {loadingObjectives || "Continue"}
          {!loadingObjectives && <ArrowRight className="h-4 w-4" />}
        </button>
      </div>
    </Panel>
  );

  const renderFileStep = () => (
    <Panel title="Upload the completed assessment" description="Excel (.xlsx, .xls) or CSV. It can come from any tool or vendor, so don't worry about the layout. We'll work out the columns next.">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
        }}
        className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 cursor-pointer transition-colors ${
          dragging ? "border-primary bg-primary/10" : "border-border hover:bg-surface-raised"
        }`}
      >
        {readingFile ? <Loader2 className="h-6 w-6 animate-spin text-primary" /> : <Upload className="h-6 w-6 text-muted-foreground" />}
        <span className="text-sm font-medium text-foreground">{readingFile ? "Reading the file..." : "Drop your file here"}</span>
        <span className="text-xs text-muted-foreground">or click to choose a file</span>
        <input ref={fileInput} type="file" accept=".xlsx,.xlsm,.xls,.csv,.tsv,.txt" className="hidden" onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])} />
      </label>
      {fileError && <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{fileError}</div>}
      {fileName && sheet && !fileError && (
        <div className="rounded-md border border-success/30 bg-success/10 p-3 text-xs text-foreground flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4 text-success" />
          <span>
            <strong>{fileName}</strong> read: {plural(sheets.length, "sheet")}, using "{sheet.name}".
          </span>
        </div>
      )}
      <div className="flex justify-between">
        {backButton(1)}
        <button onClick={() => go(3)} disabled={!sheet || readingFile} className={primaryButton}>
          Continue <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </Panel>
  );

  const renderColumnsStep = () => {
    const body = sheet.rows.slice(headerRow + 1);
    const samples = (col: number) => body.map((r) => r[col]?.text).filter(Boolean).slice(0, 3);
    const columns = headers.map((h, col) => ({ h, col, ex: samples(col) })).filter((c) => c.h || c.ex.length);
    return (
      <Panel
        title="Check the columns"
        description="We've guessed what each column holds. Change anything that's wrong. You need at least a response, plus an objective ID, name or description to match on."
      >
        <div className="flex flex-wrap gap-4">
          <label className="text-xs text-muted-foreground space-y-1">
            <span>Sheet</span>
            <select value={String(sheetIdx)} onChange={(e) => selectSheet(sheets, Number(e.target.value))} className={`${selectClass} block w-64`}>
              {sheets.map((s, i) => (
                <option key={i} value={i}>{`${s.name} (${s.rows.length} rows)`}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted-foreground space-y-1">
            <span>Header row</span>
            <select value={String(headerRow)} onChange={(e) => applyColumns(sheet, Number(e.target.value))} className={`${selectClass} block w-96`}>
              {sheet.rows.slice(0, 30).map((r, i) => {
                const preview = r.map((c) => c.text).filter(Boolean).slice(0, 4).join(" | ");
                return <option key={i} value={i}>{`Row ${i + 1}: ${preview.slice(0, 70) || "(empty)"}`}</option>;
              })}
            </select>
          </label>
        </div>
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-surface-raised text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">Column in your file</th>
                <th className="text-left font-medium px-3 py-2">Example values</th>
                <th className="text-left font-medium px-3 py-2 w-56">What it holds</th>
              </tr>
            </thead>
            <tbody>
              {columns.map(({ h, col, ex }) => (
                <tr key={col} className="border-t border-border">
                  <td className="px-3 py-2 font-medium text-foreground">{h || `Column ${col + 1}`}</td>
                  <td className="px-3 py-2 text-muted-foreground max-w-md truncate" title={ex.join(" / ")}>
                    {ex.join(" / ") || <span className="italic">empty</span>}
                  </td>
                  <td className="px-3 py-2">
                    <select value={roles[col]} onChange={(e) => setRole(col, e.target.value)} className={`${selectClass} w-full ${roles[col] !== "ignore" ? "border-primary/60" : ""}`}>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {plural(records.length, "answer row")} found
          {skipped.length ? `, ${plural(skipped.length, "other row")} ignored (titles, section headings, blank answers)` : ""}.
        </p>
        {columnError && <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{columnError}</div>}
        <div className="flex justify-between">
          {backButton(2)}
          <button onClick={continueFromColumns} className={primaryButton}>
            Continue <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </Panel>
    );
  };

  const renderResponsesStep = () => {
    const missing = [!hasNotes && "notes", !hasEvidence && "evidence"].filter(Boolean) as string[];
    return (
      <Panel title="Translate the responses" description="Each answer used in your file needs a ControlMap status. We've filled in what we could. Highlighted rows need you.">
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-surface-raised text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">Response in your file</th>
                <th className="text-left font-medium px-3 py-2 w-20">Rows</th>
                <th className="text-left font-medium px-3 py-2 w-56">ControlMap status</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => {
                const k = normalizeResponse(s.value);
                const chosen = statusChoices[k] || "";
                return (
                  <tr key={k} className={`border-t border-border ${chosen ? "" : "bg-warning/10"}`}>
                    <td className="px-3 py-2 text-foreground">{s.value || <span className="italic text-muted-foreground">(blank)</span>}</td>
                    <td className="px-3 py-2 text-muted-foreground">{s.count}</td>
                    <td className="px-3 py-2">
                      <select
                        value={chosen}
                        onChange={(e) => setStatusChoices((prev) => ({ ...prev, [k]: e.target.value }))}
                        className={`${selectClass} w-full ${chosen ? "border-primary/60" : "border-warning"}`}
                      >
                        <option value="">Choose a status</option>
                        {[...CM_STATUSES, KEEP_STATUS].map((st) => (
                          <option key={st} value={st}>{st === KEEP_STATUS ? "Leave status unchanged" : st}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-foreground">Notes and evidence</h4>
          <p className="text-[11px] text-muted-foreground">Where should the text from your notes and evidence columns go on each objective? Existing text in that field is replaced.</p>
          <div className="flex flex-wrap gap-4">
            {(
              [
                ["notes", "Notes go to", hasNotes],
                ["evidence", "Evidence goes to", hasEvidence],
              ] as const
            ).map(([key, label, has]) => (
              <label key={key} className="text-xs text-muted-foreground space-y-1">
                <span>{label}</span>
                <select
                  value={has ? targets[key] : "none"}
                  disabled={!has}
                  onChange={(e) => setTargets((t) => ({ ...t, [key]: e.target.value }))}
                  className={`${selectClass} block w-64`}
                >
                  {Object.entries(TEXT_TARGETS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {missing.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              No {missing.join(" or ")} column was chosen on the Columns step, so there's nothing to import there. If your file has one, go back and set that column to{" "}
              {missing.map((m) => `"${m === "notes" ? "Notes" : "Evidence"}"`).join(" or ")}.
            </p>
          )}
        </div>
        <div className="flex justify-between">
          {backButton(3)}
          <button onClick={continueFromResponses} className={primaryButton}>
            Match Objectives <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </Panel>
    );
  };

  const renderReviewRow = (i: number) => {
    const r = records[i];
    const m = matches[i];
    const st = rowState(i);
    const targetId = accepted[i] ?? m.objectiveId;
    const o = targetId != null ? index!.byId.get(targetId) : null;
    const manual = accepted[i] != null && accepted[i] !== m.objectiveId;
    const src = r.title || r.description;
    const dupWith = duplicates.get(i);
    return (
      <div key={i} className={`grid grid-cols-[1fr_auto_1fr_auto] gap-3 px-4 py-3 border-t border-border first:border-t-0 ${st === "skipped" ? "opacity-50" : ""}`}>
        <div className="min-w-0">
          <div className="text-xs font-semibold text-foreground">
            {r.code || "No ID"} <span className="font-normal text-muted-foreground">row {r.rowNumber}</span>
          </div>
          <div className="text-xs text-muted-foreground line-clamp-2" title={src}>{src}</div>
          <div className="text-[11px] text-muted-foreground mt-1">
            Response: <span className="text-foreground font-medium">{r.response || "(blank)"}</span>
          </div>
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground mt-1" />
        <div className="min-w-0">
          {o ? (
            <>
              <div className="text-xs font-semibold text-primary">{o.code}</div>
              <div className="text-xs text-foreground line-clamp-2" title={o.name}>{o.name}</div>
            </>
          ) : (
            <div className="text-xs text-muted-foreground">No objective found</div>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-1">
            {manual ? <Badge className="bg-primary/15 text-primary">Chosen by you</Badge> : <Badge className={BAND_COLORS[m.band]}>{BAND_LABELS[m.band]}</Badge>}
            {!manual && <span className="text-[10px] text-muted-foreground">{m.reason}</span>}
          </div>
          {dupWith && (
            <div className="text-[10px] text-warning mt-1">
              Also matched by row{dupWith.length > 1 ? "s" : ""} {dupWith.map((d) => records[d].rowNumber).join(", ")}. Their responses will be combined.
            </div>
          )}
          {pickerRow === i && (
            <ObjectivePicker
              index={index!}
              match={m}
              onPick={(id) => {
                setAcceptedAt(i, id);
                setSkipped(i, false);
                setPickerRow(null);
              }}
            />
          )}
        </div>
        <div className="flex flex-col gap-1 items-stretch w-20">
          {st === "review" && o && (
            <button onClick={() => setAcceptedAt(i, m.objectiveId)} className="text-[11px] px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90">
              Accept
            </button>
          )}
          {st === "accepted" && (
            <button onClick={() => setAcceptedAt(i, null)} className={smallButton}>
              Undo
            </button>
          )}
          <button onClick={() => setPickerRow(pickerRow === i ? null : i)} className={smallButton}>
            {pickerRow === i ? "Cancel" : o ? "Change" : "Choose"}
          </button>
          {st === "skipped" ? (
            <button onClick={() => setSkipped(i, false)} className={smallButton}>
              Unskip
            </button>
          ) : (
            <button onClick={() => setSkipped(i, true)} className={smallButton}>
              Skip
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderReviewStep = () => {
    const tabs: Array<[ReviewFilter, string, number]> = [
      ["review", "Need a look", counts.review],
      ["accepted", "Matched", counts.accepted],
      ["duplicates", "Same objective twice", duplicates.size],
      ["skipped", "Skipped", counts.skipped],
      ["all", "All rows", matches.length],
    ];
    return (
      <Panel
        title="Review the matches"
        description={
          counts.review
            ? `${counts.accepted} of ${matches.length} rows are matched. ${counts.review} need${counts.review === 1 ? "s" : ""} a quick look: accept our suggestion, pick a different objective, or skip the row.`
            : `All ${matches.length} rows are matched or skipped. Look through them if you like, then continue.`
        }
      >
        {fit.likelyWrongFramework && (
          <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-foreground flex gap-2">
            <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
            <span>
              <strong>Is this the right framework?</strong> Very few rows look like {framework?.name ?? "this framework's"} objectives. If this assessment is for a different framework, go back to step 1 and choose it.
            </span>
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <Stat value={counts.accepted} label="Matched" tone="ok" />
          <Stat value={counts.review} label="Need a look" tone="warn" />
          <Stat value={counts.skipped} label="Skipped" />
        </div>
        <div className="rounded-md border border-border overflow-hidden">
          <div className="p-3 border-b border-border space-y-3">
            <div className="flex flex-wrap gap-1">
              {tabs
                .filter(([k, , c]) => c || k === "all" || k === filter)
                .map(([k, label, c]) => (
                  <button
                    key={k}
                    onClick={() => setFilter(k)}
                    className={`text-xs px-3 py-1.5 rounded-md ${filter === k ? "bg-primary/15 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-surface-raised"}`}
                  >
                    {label} ({c})
                  </button>
                ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input type="text" placeholder="Search rows or objectives..." value={search} onChange={(e) => setSearch(e.target.value)} className={`${inputClass} pl-8`} />
              </div>
              {filter === "review" && pendingSuggestions.length > 0 && (
                <button onClick={() => acceptAllSuggestions()} className="text-xs px-3 h-8 rounded-md bg-primary text-primary-foreground hover:bg-primary/90">
                  {pendingSuggestions.length === 1 ? "Accept 1 Suggestion" : `Accept All ${pendingSuggestions.length} Suggestions`}
                </button>
              )}
              {filter === "review" && pendingUnmatched > 0 && (
                <button onClick={skipUnmatched} className="text-xs px-3 h-8 rounded-md border border-border text-foreground hover:bg-surface-raised">
                  Skip {pendingUnmatched} Unmatched {pendingUnmatched === 1 ? "Row" : "Rows"}
                </button>
              )}
            </div>
          </div>
          {reviewPage.rows.length ? reviewPage.rows.map(renderReviewRow) : <p className="p-4 text-xs text-muted-foreground">Nothing here.</p>}
          <Pagination page={reviewPage.page} totalPages={reviewPage.totalPages} onPageChange={reviewPage.setPage} />
        </div>
        <div className="flex justify-between">
          {backButton(4)}
          <button onClick={() => go(6)} disabled={acceptedCount === 0} className={primaryButton}>
            {counts.review ? `Continue With ${acceptedCount} Matched Rows` : "Continue"} <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </Panel>
    );
  };

  const renderUpdateStep = () => {
    const finished = !running && results.length > 0;
    const okCount = results.length - failed.length;
    const title = running ? "Updating ControlMap..." : finished ? (failed.length ? "Finished, with some problems" : "ControlMap is updated") : "Ready to update ControlMap";
    const description = running
      ? "Keep this tab open until it finishes."
      : finished
        ? failed.length
          ? `${plural(okCount, "objective was", "objectives were")} updated. ${failed.length} couldn't be updated; the reasons are below. You can retry them.`
          : `${plural(okCount, "objective was", "objectives were")} updated. Download the change log to keep a record of each objective's status before and after.`
        : `${plural(updates.length, `${framework?.name ?? ""} objective`)} for ${client?.name} will be updated. Existing status and text in the chosen fields are replaced. Nothing changes until you press Update ControlMap.`;
    return (
      <Panel title={title} description={description}>
        <div className="flex flex-wrap gap-3">
          <Stat value={updates.length} label="Objectives to update" tone="primary" />
          <Stat value={statusChanges} label="Status changes" tone="ok" />
          <Stat value={withText} label="With notes or evidence" />
          <Stat value={notImported} label="Rows not imported" tone={notImported ? "warn" : undefined} />
        </div>
        {answersChildren && !finished && (
          <label className="flex items-center gap-2 text-xs text-foreground">
            <Checkbox checked={rollUp} onCheckedChange={(v) => setRollUp(!!v)} disabled={running} />
            Also set each practice's status from its sub-objectives when all of them were answered
          </label>
        )}
        <div className="rounded-md border border-border overflow-hidden">
          <button onClick={() => setShowPlan((s) => !s)} className="w-full flex items-center justify-between px-3 py-2 text-xs text-foreground hover:bg-surface-raised">
            <span className="font-medium">See every change</span>
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${showPlan ? "rotate-90" : ""}`} />
          </button>
          {showPlan && (
            <>
              <table className="w-full text-xs border-t border-border">
                <thead className="bg-surface-raised text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Objective</th>
                    <th className="text-left font-medium px-3 py-2">Status</th>
                    <th className="text-left font-medium px-3 py-2">Also updates</th>
                    <th className="text-left font-medium px-3 py-2">From rows</th>
                  </tr>
                </thead>
                <tbody>
                  {planPage.rows.map((u) => (
                    <tr key={u.objectiveId} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="font-medium text-foreground">{u.code}</div>
                        <div className="text-muted-foreground line-clamp-1">{u.name}</div>
                      </td>
                      <td className="px-3 py-2 text-foreground">
                        {u.body.status ? (
                          <>
                            <span className="text-muted-foreground">{u.statusBefore || "?"}</span> → <strong>{u.body.status}</strong>
                          </>
                        ) : (
                          <span className="text-muted-foreground">unchanged</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {[u.body.implementation_details && "Implementation details", u.body.remarks && "Remarks"].filter(Boolean).join(", ") || "-"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{u.note || u.rows.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination page={planPage.page} totalPages={planPage.totalPages} onPageChange={planPage.setPage} />
            </>
          )}
        </div>
        {(running || finished) && (
          <div className="space-y-1">
            <div className="h-2 rounded-full bg-surface-raised overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${progress.total ? Math.round((100 * progress.done) / progress.total) : 0}%` }} />
            </div>
            <div className="text-[11px] text-muted-foreground">
              {progress.done} of {plural(progress.total, "objective")}
            </div>
          </div>
        )}
        {finished && !failed.length && (
          <div className="flex items-center gap-2 text-xs text-success">
            <CheckCircle2 className="h-4 w-4" /> Every objective was updated.
          </div>
        )}
        {failed.length > 0 && !running && (
          <div className="space-y-2">
            {failed.map((f) => (
              <div key={f.objectiveId} className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs">
                <div className="flex items-center gap-2 text-foreground">
                  <XCircle className="h-3.5 w-3.5 text-destructive" />
                  <strong>{f.code}</strong> {f.name}
                </div>
                <p className="text-destructive mt-1">{f.error}</p>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          {finished ? <span /> : backButton(5)}
          <div className="flex flex-wrap gap-2">
            {finished && (
              <>
                <button onClick={downloadLog} className={secondaryButton}>
                  <Download className="h-4 w-4" /> Download Change Log
                </button>
                {failed.length > 0 && (
                  <button onClick={() => runUpdates(failed, results)} className={secondaryButton}>
                    <RotateCcw className="h-4 w-4" /> Retry Failed
                  </button>
                )}
                <button onClick={startOver} className={primaryButton}>
                  Import Another File
                </button>
              </>
            )}
            {!finished && (
              <button onClick={() => setConfirmRun(true)} disabled={!updates.length || running} className={primaryButton}>
                {running && <Loader2 className="h-4 w-4 animate-spin" />}
                Update ControlMap
              </button>
            )}
          </div>
        </div>
      </Panel>
    );
  };

  return (
    <div ref={rootRef} className="space-y-4 scroll-mt-4">
      <StepIndicator current={screen} reached={reached} onGo={go} locked={running} />

      {screen === 1 && renderClientStep()}
      {screen === 2 && renderFileStep()}
      {screen === 3 && sheet && renderColumnsStep()}
      {screen === 4 && renderResponsesStep()}
      {screen === 5 && index && renderReviewStep()}
      {screen === 6 && renderUpdateStep()}

      <AlertDialog open={!!confirmBulk} onOpenChange={(open) => !open && setConfirmBulk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Accept all {confirmBulk?.total} suggestions?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmBulk?.weak} of these suggestions are low confidence: the wording in your file reads quite differently from the ControlMap objective. Accepting them all may write answers to the wrong
              objectives. We recommend checking the low-confidence rows one by one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Check Them First</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmBulk(null);
                acceptAllSuggestions(true);
              }}
            >
              Accept All Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRun} onOpenChange={setConfirmRun}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update {plural(updates.length, "objective")} in ControlMap?</AlertDialogTitle>
            <AlertDialogDescription>
              This writes to {client?.name}'s {framework?.name} objectives. Existing status and text in the chosen fields are replaced. Download the change log afterwards to keep a record of
              each objective's status before the import.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmRun(false);
                setResults([]);
                runUpdates(updates, []);
              }}
            >
              Update ControlMap
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
