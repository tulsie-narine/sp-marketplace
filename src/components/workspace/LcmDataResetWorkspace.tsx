import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCcw,
  Search,
  Save,
  Trash2,
  Clock,
  TriangleAlert,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import DemoDataGenerator from "@/components/workspace/DemoDataGenerator";
import {
  DEFAULT_RESET_SELECTED_OBJECTS,
  RESET_OBJECT_OPTIONS,
  fetchAllClients,
  runLcmDataReset,
  type LcmDataResetClientProgress,
  type LcmDataResetResult,
} from "@/lib/lcm-data-reset-api";
import {
  OBJECT_LABELS,
  type MigrationClient,
  type MigrationObjectType,
  type ProgressStatus,
  type SelectedObjects,
} from "@/lib/tenant-migration-api";
import {
  deleteConfig,
  listConfigs,
  saveConfig,
  setScheduleEnabled,
  type LcmDataResetConfig,
} from "@/lib/lcm-config-api";

const PAGE_SIZE = 8;
const FINAL_TABS = ["summary", "errors", "relationships"] as const;
const RESET_CONFIRM_TEXT = "RESET";

type FinalTab = (typeof FINAL_TABS)[number];
type Screen = 1 | 2 | 3 | 4;

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between border-t border-border px-3 py-2">
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page === 1}
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
      >
        <ChevronLeft className="h-3 w-3" />
        Prev
      </button>
      <span className="text-[10px] text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page === totalPages}
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
      >
        Next
        <ChevronRight className="h-3 w-3" />
      </button>
    </div>
  );
}

function StepIndicator({
  currentScreen,
  actions,
}: {
  currentScreen: Screen;
  actions?: ReactNode;
}) {
  const steps = [
    { id: 1, label: "Source Client" },
    { id: 2, label: "Destination Clients" },
    { id: 3, label: "Reset Options" },
    { id: 4, label: "Run" },
  ] as const;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {steps.map((step, index) => (
            <div key={step.id} className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div
                  className={classNames(
                    "flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold",
                    currentScreen === step.id && "border-primary bg-primary/15 text-primary",
                    currentScreen > step.id && "border-success bg-success/10 text-success",
                    currentScreen < step.id && "border-border bg-surface-raised text-muted-foreground"
                  )}
                >
                  {step.id}
                </div>
                <span
                  className={classNames(
                    "text-xs font-medium",
                    currentScreen === step.id ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {step.label}
                </span>
              </div>
              {index < steps.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />}
            </div>
          ))}
        </div>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>
    </div>
  );
}

function StatusPill({
  status,
  count,
}: {
  status: ProgressStatus;
  count?: string;
}) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning">
        <Loader2 className="h-3 w-3 animate-spin" />
        running
      </span>
    );
  }

  return (
    <span
      className={classNames(
        "rounded-full px-2 py-0.5 text-[10px] font-medium",
        status === "success" && "bg-success/15 text-success",
        status === "partial" && "bg-warning/15 text-warning",
        status === "failed" && "bg-destructive/15 text-destructive",
        status === "skipped" && "bg-muted text-muted-foreground",
        status === "pending" && "bg-surface-raised text-muted-foreground"
      )}
    >
      {count ? `${status} ${count}` : status}
    </span>
  );
}

export function LcmDataResetWorkspace() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [currentScreen, setCurrentScreen] = useState<Screen>(1);
  const [tenantMode, setTenantMode] = useState<"cross" | "same">("cross");
  const [sourceApiKey, setSourceApiKey] = useState("");
  const [destinationApiKey] = useState(
    () =>
      window.sessionStorage.getItem("sp_api_key") ||
      window.sessionStorage.getItem("scalepad_api_key") ||
      ""
  );
  const [sourceClients, setSourceClients] = useState<MigrationClient[]>([]);
  const [destinationClients, setDestinationClients] = useState<MigrationClient[]>([]);
  const [selectedSourceClientId, setSelectedSourceClientId] = useState("");
  const [selectedDestinationIds, setSelectedDestinationIds] = useState<Set<string>>(new Set());
  const [selectedObjects, setSelectedObjects] = useState<SelectedObjects>(
    DEFAULT_RESET_SELECTED_OBJECTS
  );
  const [confirmationText, setConfirmationText] = useState("");
  const [sourceSearch, setSourceSearch] = useState("");
  const [destinationSearch, setDestinationSearch] = useState("");
  const [sourcePage, setSourcePage] = useState(1);
  const [destinationPage, setDestinationPage] = useState(1);
  const [loadingSourceClients, setLoadingSourceClients] = useState(false);
  const [loadingDestinationClients, setLoadingDestinationClients] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progressList, setProgressList] = useState<LcmDataResetClientProgress[]>([]);
  const [result, setResult] = useState<LcmDataResetResult | null>(null);
  const [finalTab, setFinalTab] = useState<FinalTab>("summary");

  // Saved-configuration state (per-user persistence + nightly schedule)
  const [savedConfigs, setSavedConfigs] = useState<LcmDataResetConfig[]>([]);
  const [loadingConfigs, setLoadingConfigs] = useState(false);
  const [activeConfigId, setActiveConfigId] = useState<string | null>(null);
  const [configName, setConfigName] = useState("Default");
  const [scheduleNightly, setScheduleNightly] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  useEffect(() => setSourcePage(1), [sourceSearch]);
  useEffect(() => setDestinationPage(1), [destinationSearch]);

  // Load saved configurations on mount
  useEffect(() => {
    let cancelled = false;
    setLoadingConfigs(true);
    listConfigs()
      .then((configs) => {
        if (cancelled) return;
        setSavedConfigs(configs);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn("Failed to load saved configs", error);
      })
      .finally(() => {
        if (!cancelled) setLoadingConfigs(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!destinationApiKey) return;
    const loadDestinationClients = async () => {
      setLoadingDestinationClients(true);
      setDestinationError(null);
      try {
        setDestinationClients(await fetchAllClients(destinationApiKey));
      } catch (error) {
        setDestinationError(
          error instanceof Error ? error.message : "Failed to load destination clients."
        );
      } finally {
        setLoadingDestinationClients(false);
      }
    };
    loadDestinationClients();
  }, [destinationApiKey]);

  // In same-tenant mode, the source clients are the same list as destination clients.
  useEffect(() => {
    if (tenantMode !== "same") return;
    setSourceClients(destinationClients);
    setSourceError(null);
  }, [tenantMode, destinationClients]);

  // When switching modes, clear selections so users explicitly re-pick.
  useEffect(() => {
    setSelectedSourceClientId("");
    setSelectedDestinationIds(new Set());
    if (tenantMode === "same") {
      setSourceApiKey("");
    } else {
      setSourceClients([]);
    }
  }, [tenantMode]);

  const selectedSourceClient = useMemo(
    () => sourceClients.find((client) => client.id === selectedSourceClientId) || null,
    [sourceClients, selectedSourceClientId]
  );
  const selectedDestinationClients = useMemo(
    () => destinationClients.filter((client) => selectedDestinationIds.has(client.id)),
    [destinationClients, selectedDestinationIds]
  );
  const filteredSourceClients = useMemo(() => {
    const query = sourceSearch.trim().toLowerCase();
    if (!query) return sourceClients;
    return sourceClients.filter((client) => client.name.toLowerCase().includes(query));
  }, [sourceClients, sourceSearch]);
  const filteredDestinationClients = useMemo(() => {
    const query = destinationSearch.trim().toLowerCase();
    const base =
      tenantMode === "same" && selectedSourceClientId
        ? destinationClients.filter((client) => client.id !== selectedSourceClientId)
        : destinationClients;
    if (!query) return base;
    return base.filter((client) => client.name.toLowerCase().includes(query));
  }, [destinationClients, destinationSearch, tenantMode, selectedSourceClientId]);
  const sourceTotalPages = Math.max(1, Math.ceil(filteredSourceClients.length / PAGE_SIZE));
  const destinationTotalPages = Math.max(
    1,
    Math.ceil(filteredDestinationClients.length / PAGE_SIZE)
  );
  const pagedSourceClients = filteredSourceClients.slice(
    (sourcePage - 1) * PAGE_SIZE,
    sourcePage * PAGE_SIZE
  );
  const pagedDestinationClients = filteredDestinationClients.slice(
    (destinationPage - 1) * PAGE_SIZE,
    destinationPage * PAGE_SIZE
  );
  const selectedObjectCount = useMemo(
    () => Object.values(selectedObjects).filter(Boolean).length,
    [selectedObjects]
  );
  const hasConfirmation = confirmationText.trim().toUpperCase() === RESET_CONFIRM_TEXT;
  const completedClients = useMemo(
    () => progressList.filter((item) => item.stage === "complete").length,
    [progressList]
  );

  const loadSourceClients = async () => {
    if (!sourceApiKey.trim()) {
      setSourceError("Source tenant API key is required.");
      return;
    }
    setLoadingSourceClients(true);
    setSourceError(null);
    try {
      const clients = await fetchAllClients(sourceApiKey.trim());
      setSourceClients(clients);
      toast({
        title: "Source clients loaded",
        description: `Loaded ${clients.length} source clients.`,
      });
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Failed to load source clients.");
    } finally {
      setLoadingSourceClients(false);
    }
  };

  const toggleDestinationClient = (clientId: string) => {
    setSelectedDestinationIds((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  };

  const selectAllDestinationPage = () => {
    setSelectedDestinationIds((prev) => {
      const next = new Set(prev);
      pagedDestinationClients.forEach((client) => next.add(client.id));
      return next;
    });
  };

  const clearDestinationPage = () => {
    setSelectedDestinationIds((prev) => {
      const next = new Set(prev);
      pagedDestinationClients.forEach((client) => next.delete(client.id));
      return next;
    });
  };

  const startRun = async () => {
    if (!selectedSourceClient) {
      toast({
        title: "Select a source client",
        description: "Choose the source client that should be cloned into the destination clients.",
        variant: "destructive",
      });
      return;
    }
    if (selectedDestinationClients.length === 0) {
      toast({
        title: "Select destination clients",
        description: "Choose at least one destination client before starting the run.",
        variant: "destructive",
      });
      return;
    }
    if (selectedObjectCount === 0) {
      toast({
        title: "Select object types",
        description: "Choose at least one object type to reset and migrate.",
        variant: "destructive",
      });
      return;
    }
    if (!hasConfirmation) {
      toast({
        title: "Confirm the destructive action",
        description: `Type ${RESET_CONFIRM_TEXT} to confirm that selected destination data will be deleted first.`,
        variant: "destructive",
      });
      return;
    }

    setRunError(null);
    setResult(null);
    setProgressList([]);
    setFinalTab("summary");
    setCurrentScreen(4);
    setRunning(true);

    try {
      const runResult = await runLcmDataReset({
        sourceApiKey:
          tenantMode === "same" ? destinationApiKey : sourceApiKey.trim(),
        destinationApiKey,
        sourceClient: selectedSourceClient,
        destinationClients: selectedDestinationClients,
        selectedObjects,
        onClientProgress: (clientIndex, progress) => {
          setProgressList((prev) => {
            const next = [...prev];
            next[clientIndex] = progress;
            return next;
          });
        },
      });
      setResult(runResult);
      toast({
        title: "LCM Data Reset complete",
        description: `${runResult.clientSummaries.length} destination clients processed, ${runResult.totalDeleted} records deleted, ${runResult.totalCreated} records created.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setRunError(message);
      toast({
        title: "LCM Data Reset stopped unexpectedly",
        description: message,
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  };

  const exportErrorsAsCsv = () => {
    if (!result || result.errors.length === 0) return;
    const header = ["Client", "Object Type", "Record", "Error Code", "Error Detail"];
    const rows = result.errors.map((entry) => [
      entry.clientName,
      entry.objectType,
      entry.recordName,
      entry.errorCode,
      entry.errorDetail,
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "lcm-data-reset-errors.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const resetWorkflow = () => {
    setCurrentScreen(1);
    setSelectedSourceClientId("");
    setSelectedDestinationIds(new Set());
    setSelectedObjects(DEFAULT_RESET_SELECTED_OBJECTS);
    setConfirmationText("");
    setRunError(null);
    setRunning(false);
    setProgressList([]);
    setResult(null);
    setFinalTab("summary");
  };

  const renderScreenOne = () => (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="mb-6 flex items-center gap-4">
          <span className="text-4xl">🧰</span>
          <div>
            <h2 className="font-heading text-2xl font-bold text-foreground">LCM Data Reset</h2>
            <p className="text-sm text-muted-foreground">
              Choose one source client, then reset and repopulate multiple destination clients.
            </p>
          </div>
        </div>

        <div className="mb-6">
          <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Clone Mode
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setTenantMode("cross")}
              className={classNames(
                "rounded-md border p-3 text-left transition-colors",
                tenantMode === "cross"
                  ? "border-primary bg-primary/10"
                  : "border-border bg-surface-raised/40 hover:bg-surface-raised"
              )}
            >
              <p className="text-sm font-medium text-foreground">Cross-tenant clone</p>
              <p className="text-xs text-muted-foreground">
                Source client lives in a different tenant. Requires a source tenant API key.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setTenantMode("same")}
              className={classNames(
                "rounded-md border p-3 text-left transition-colors",
                tenantMode === "same"
                  ? "border-primary bg-primary/10"
                  : "border-border bg-surface-raised/40 hover:bg-surface-raised"
              )}
            >
              <p className="text-sm font-medium text-foreground">Same-tenant clone (gold client)</p>
              <p className="text-xs text-muted-foreground">
                Pick a gold client inside the connected tenant and replicate it to other clients in the same tenant.
              </p>
            </button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-success/20 bg-success/5 p-4">
            <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {tenantMode === "same" ? "Tenant (connected)" : "Destination Tenant (connected)"}
            </label>
            <p className="font-mono text-sm text-foreground">
              {destinationApiKey ? "Connected via session API key" : "Not connected"}
            </p>
          </div>

          {tenantMode === "cross" ? (
            <div className="rounded-lg border border-border bg-surface-raised/50 p-4">
              <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Source Tenant API Key
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={sourceApiKey}
                  onChange={(event) => setSourceApiKey(event.target.value)}
                  placeholder="Paste the source tenant API key"
                  className="h-10 flex-1 rounded-md border border-border bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  onClick={loadSourceClients}
                  disabled={loadingSourceClients}
                  className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {loadingSourceClients && <Loader2 className="h-4 w-4 animate-spin" />}
                  Load
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-surface-raised/50 p-4">
              <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Source = Destination Tenant
              </label>
              <p className="text-sm text-foreground">
                Source clients are loaded from the connected tenant. Pick the gold client below.
              </p>
              {loadingDestinationClients && (
                <p className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading clients...
                </p>
              )}
            </div>
          )}
        </div>

        {sourceError && (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {sourceError}
          </div>
        )}
        {destinationError && (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {destinationError}
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border p-4">
          <div>
            <h3 className="font-heading text-lg font-bold text-foreground">Source Client</h3>
            <p className="text-sm text-muted-foreground">
              Pick the single source client whose data will be replicated.
            </p>
          </div>
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={sourceSearch}
              onChange={(event) => setSourceSearch(event.target.value)}
              placeholder="Search source clients"
              className="h-10 w-full rounded-md border border-border bg-surface-raised pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface-raised text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Pick</th>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Lifecycle</th>
                <th className="px-4 py-3 font-medium">Assets</th>
              </tr>
            </thead>
            <tbody>
              {pagedSourceClients.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    {loadingSourceClients ? "Loading source clients..." : "No source clients to show yet."}
                  </td>
                </tr>
              ) : (
                pagedSourceClients.map((client) => (
                  <tr
                    key={client.id}
                    className={classNames(
                      "border-b border-border last:border-b-0",
                      selectedSourceClientId === client.id && "bg-primary/5"
                    )}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="radio"
                        name="source-client"
                        checked={selectedSourceClientId === client.id}
                        onChange={() => setSelectedSourceClientId(client.id)}
                      />
                    </td>
                    <td className="px-4 py-3 text-foreground">{client.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{client.lifecycle || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{client.num_hardware_assets ?? 0}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <Pagination page={sourcePage} totalPages={sourceTotalPages} onPageChange={setSourcePage} />
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => navigate("/marketplace")}
          className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-raised"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <button
          onClick={() => setCurrentScreen(2)}
          disabled={!selectedSourceClient}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  const renderScreenTwo = () => (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-heading text-lg font-bold text-foreground">
              Destination Clients
            </h3>
            <p className="text-sm text-muted-foreground">
              Select every destination client that should be reset and repopulated from{" "}
              <span className="font-medium text-foreground">{selectedSourceClient?.name}</span>.
            </p>
          </div>
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={destinationSearch}
              onChange={(event) => setDestinationSearch(event.target.value)}
              placeholder="Search destination clients"
              className="h-10 w-full rounded-md border border-border bg-surface-raised pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <button
            onClick={selectAllDestinationPage}
            className="rounded-md border border-border px-3 py-2 text-foreground transition-colors hover:bg-surface-raised"
          >
            Select page
          </button>
          <button
            onClick={clearDestinationPage}
            className="rounded-md border border-border px-3 py-2 text-foreground transition-colors hover:bg-surface-raised"
          >
            Clear page
          </button>
          <span className="text-muted-foreground">
            {selectedDestinationClients.length} destination clients selected
          </span>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-surface-raised text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Pick</th>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Lifecycle</th>
                <th className="px-4 py-3 font-medium">Assets</th>
              </tr>
            </thead>
            <tbody>
              {pagedDestinationClients.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    {loadingDestinationClients
                      ? "Loading destination clients..."
                      : "No destination clients available."}
                  </td>
                </tr>
              ) : (
                pagedDestinationClients.map((client) => (
                  <tr
                    key={client.id}
                    className={classNames(
                      "border-b border-border last:border-b-0",
                      selectedDestinationIds.has(client.id) && "bg-primary/5"
                    )}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedDestinationIds.has(client.id)}
                        onChange={() => toggleDestinationClient(client.id)}
                      />
                    </td>
                    <td className="px-4 py-3 text-foreground">{client.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{client.lifecycle || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {client.num_hardware_assets ?? 0}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <Pagination
          page={destinationPage}
          totalPages={destinationTotalPages}
          onPageChange={setDestinationPage}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => setCurrentScreen(1)}
          className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-raised"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <button
          onClick={() => setCurrentScreen(3)}
          disabled={selectedDestinationClients.length === 0}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  const renderScreenThree = () => (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-5">
        <h3 className="font-heading text-lg font-bold text-foreground">Reset and Clone</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          The selected destination clients will be cleared first, then repopulated from{" "}
          <span className="font-medium text-foreground">{selectedSourceClient?.name}</span>.
        </p>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {RESET_OBJECT_OPTIONS.map((option) => (
            <label
              key={option.key}
              className="flex items-center gap-3 rounded-md border border-border bg-surface-raised/40 px-4 py-3 text-sm text-foreground"
            >
              <input
                type="checkbox"
                checked={selectedObjects[option.key]}
                onChange={() =>
                  setSelectedObjects((prev) => ({
                    ...prev,
                    [option.key]: !prev[option.key],
                  }))
                }
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-warning/30 bg-warning/10 p-4">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 h-5 w-5 text-warning" />
          <div className="space-y-2 text-sm text-warning">
            <p className="font-medium">
              This run deletes selected Lifecycle Manager data before recreating it.
            </p>
            <p>
              Only use this against destination clients that are meant to become standardized copies of the source client.
            </p>
            <p>
              If reset fails for a destination client, migration will be skipped for that client to avoid duplicates or mixed state.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-destructive">
          Type {RESET_CONFIRM_TEXT} to confirm
        </label>
        <input
          value={confirmationText}
          onChange={(event) => setConfirmationText(event.target.value)}
          placeholder={RESET_CONFIRM_TEXT}
          className="h-10 w-full rounded-md border border-destructive/30 bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-destructive"
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => setCurrentScreen(2)}
          className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-raised"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <button
          onClick={startRun}
          disabled={
            selectedObjectCount === 0 ||
            !hasConfirmation
          }
          className="inline-flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Start Reset and Clone
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  const renderRunProgress = () => (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-heading text-lg font-bold text-foreground">
              LCM Data Reset in Progress - do not close this window
            </h3>
            <p className="text-sm text-muted-foreground">
              Destination client {Math.min(completedClients + 1, Math.max(progressList.length, 1))} of{" "}
              {progressList.length}
            </p>
          </div>
          <div className="rounded-full bg-warning/15 px-3 py-1 text-xs font-medium text-warning">
            Running
          </div>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-raised">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{
              width: `${
                progressList.length ? (completedClients / progressList.length) * 100 : 0
              }%`,
            }}
          />
        </div>
      </div>

      {progressList.map((client) => (
        <div key={client.targetClientId} className="rounded-lg border border-border bg-card p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-medium text-foreground">{client.targetClientName}</h4>
              <p className="text-xs text-muted-foreground">
                Source: {client.sourceClientName} | Stage: {client.stage}
              </p>
            </div>
            <StatusPill status={client.status} />
          </div>

          {client.note && (
            <div className="mb-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {client.note}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-md border border-border p-3">
              <h5 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Reset Phase
              </h5>
              <div className="space-y-2">
                {client.reset.sections.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Waiting to start reset.</p>
                ) : (
                  client.reset.sections.map((section) => (
                    <div key={section.type} className="flex items-center justify-between gap-3">
                      <span className="text-xs text-foreground">{section.label}</span>
                      <StatusPill
                        status={section.status}
                        count={
                          section.total > 0 ? `${section.deleted}/${section.total}` : undefined
                        }
                      />
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-md border border-border p-3">
              <h5 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Migration Phase
              </h5>
              <div className="space-y-2">
                {(Object.keys(client.migration.objects) as MigrationObjectType[]).map((type) => (
                  <div key={type} className="flex items-center justify-between gap-3">
                    <span className="text-xs text-foreground">{OBJECT_LABELS[type]}</span>
                    <StatusPill
                      status={client.migration.objects[type].status}
                      count={
                        client.migration.objects[type].total > 0
                          ? `${client.migration.objects[type].succeeded}/${client.migration.objects[type].total}`
                          : undefined
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  const renderFinalReport = () => {
    if (!result) return null;

    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="font-heading text-lg font-bold text-foreground">
                LCM Data Reset Complete
              </h3>
              <p className="text-sm text-muted-foreground">
                {result.clientSummaries.length} destination clients processed | {result.totalDeleted} records deleted | {result.totalCreated} records created | {result.totalFailures} failures
              </p>
            </div>
            <CheckCircle2 className="h-6 w-6 text-success" />
          </div>

          <div className="flex gap-2 border-t border-border pt-4">
            {FINAL_TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setFinalTab(tab)}
                className={classNames(
                  "rounded-md px-3 py-2 text-xs font-medium capitalize",
                  finalTab === tab ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {tab === "errors" ? "Error Log" : tab === "relationships" ? "Relationship Log" : "Summary"}
              </button>
            ))}
          </div>
        </div>

        {finalTab === "summary" && (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="border-b border-border bg-surface-raised text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Destination Client</th>
                    <th className="px-4 py-3 font-medium">Source Client</th>
                    <th className="px-4 py-3 font-medium">Reset Deleted</th>
                    <th className="px-4 py-3 font-medium">Migration Created</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.clientSummaries.map((summary) => (
                    <tr key={summary.targetClientId} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-3 text-foreground">{summary.targetClientName}</td>
                      <td className="px-4 py-3 text-foreground">{summary.sourceClientName}</td>
                      <td className="px-4 py-3 text-foreground">{summary.resetDeleted}</td>
                      <td className="px-4 py-3 text-foreground">{summary.migrationCreated}</td>
                      <td className="px-4 py-3">
                        <span
                          className={classNames(
                            "rounded-full px-2 py-0.5 text-[10px] font-medium",
                            summary.status === "Complete" && "bg-success/15 text-success",
                            summary.status === "Partial" && "bg-warning/15 text-warning",
                            summary.status === "Failed" && "bg-destructive/15 text-destructive"
                          )}
                        >
                          {summary.status}
                        </span>
                        {summary.note && (
                          <p className="mt-1 text-[10px] text-muted-foreground">{summary.note}</p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {finalTab === "errors" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
              <div className="text-sm text-muted-foreground">
                {result.errors.length} logged errors and warnings
              </div>
              <button
                onClick={exportErrorsAsCsv}
                disabled={result.errors.length === 0}
                className="rounded-md border border-border px-3 py-2 text-xs text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
              >
                Export Error Log as CSV
              </button>
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-xs">
                  <thead className="border-b border-border bg-surface-raised text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">Client</th>
                      <th className="px-4 py-3 font-medium">Object Type</th>
                      <th className="px-4 py-3 font-medium">Record</th>
                      <th className="px-4 py-3 font-medium">Code</th>
                      <th className="px-4 py-3 font-medium">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.errors.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                          No errors were logged.
                        </td>
                      </tr>
                    ) : (
                      result.errors.map((entry, index) => (
                        <tr key={`${entry.clientName}-${entry.recordName}-${index}`} className="border-b border-border last:border-b-0">
                          <td className="px-4 py-3 text-foreground">{entry.clientName}</td>
                          <td className="px-4 py-3 text-foreground">{entry.objectType}</td>
                          <td className="px-4 py-3 text-foreground">{entry.recordName}</td>
                          <td className="px-4 py-3 text-destructive">{entry.errorCode}</td>
                          <td className="px-4 py-3 text-muted-foreground">{entry.errorDetail}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {finalTab === "relationships" && (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="border-b border-border bg-surface-raised text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Client</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Source Record</th>
                    <th className="px-4 py-3 font-medium">Target Record</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.relationshipLog.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                        No relationships were created or logged during this run.
                      </td>
                    </tr>
                  ) : (
                    result.relationshipLog.map((entry, index) => (
                      <tr key={`${entry.clientName}-${entry.type}-${index}`} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-3 text-foreground">{entry.clientName}</td>
                        <td className="px-4 py-3 text-foreground">{entry.type}</td>
                        <td className="px-4 py-3 text-foreground">{entry.sourceRecord}</td>
                        <td className="px-4 py-3 text-foreground">{entry.targetRecord}</td>
                        <td className="px-4 py-3 text-foreground">{entry.status}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <button
            onClick={resetWorkflow}
            className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-raised"
          >
            <RefreshCcw className="h-4 w-4" />
            Run Another Reset
          </button>
          <button
            onClick={() => navigate("/marketplace")}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Done
          </button>
        </div>
      </div>
    );
  };

  if (!destinationApiKey) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-muted-foreground">
          Please set your ScalePad API key on the Settings page before using LCM Data Reset.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <StepIndicator
        currentScreen={currentScreen}
        actions={<DemoDataGenerator triggerLabel="Generate PSA Data" />}
      />

      {currentScreen === 1 && renderScreenOne()}
      {currentScreen === 2 && renderScreenTwo()}
      {currentScreen === 3 && renderScreenThree()}
      {currentScreen === 4 && (
        <>
          {running && renderRunProgress()}
          {!running && result && renderFinalReport()}
          {!running && !result && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5" />
                <div>
                  <p className="font-medium">The run did not finish successfully.</p>
                  <p className="mt-1">{runError || "LCM Data Reset did not produce a final report."}</p>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
