import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  autoMatchClientMappings,
  buildInitialClientProgress,
  fetchAllClients,
  fetchDestinationUsers,
  maskApiKey,
  OBJECT_LABELS,
  runTenantMigration,
  type ClientMapping,
  type ClientMigrationProgress,
  type MigrationClient,
  type MigrationObjectType,
  type MigrationResult,
  type DestinationUserOption,
  type RelationshipLogEntry,
  type SelectedObjects,
} from "@/lib/tenant-migration-api";

const PAGE_SIZE = 8;
const FINAL_TABS = ["summary", "errors", "relationships"] as const;
const OBJECT_OPTIONS: { key: keyof SelectedObjects; label: string }[] = [
  { key: "initiatives", label: "Initiatives" },
  { key: "goals", label: "Goals" },
  { key: "notes", label: "Notes" },
  { key: "actionItems", label: "Action Items" },
  { key: "contracts", label: "Contracts" },
  { key: "assessments", label: "Assessments" },
  { key: "meetings", label: "Meetings" },
  { key: "deliverables", label: "Deliverables" },
];

type FinalTab = (typeof FINAL_TABS)[number];

type TenantMigrationWorkspaceCopy = {
  title: string;
  subtitle: string;
  stepFourLabel: string;
  runButtonLabel: string;
  runningTitle: string;
  completeToastTitle: string;
  stoppedToastTitle: string;
  completeHeading: string;
  runAgainLabel: string;
  errorCsvFilename: string;
  debugJsonFilename: string;
  finalSummaryVerb: string;
};

const DEFAULT_COPY: TenantMigrationWorkspaceCopy = {
  title: "Tenant Migration",
  subtitle: "Migrate data from one ScalePad tenant to another",
  stepFourLabel: "Migration",
  runButtonLabel: "Start Migration",
  runningTitle: "Migration in Progress - do not close this window",
  completeToastTitle: "Migration complete",
  stoppedToastTitle: "Migration stopped unexpectedly",
  completeHeading: "Migration Complete",
  runAgainLabel: "Run Another Migration",
  errorCsvFilename: "tenant-migration-errors.csv",
  debugJsonFilename: "tenant-migration-debug-export.json",
  finalSummaryVerb: "migrated",
};

const DEFAULT_SELECTED_OBJECTS: SelectedObjects = {
  initiatives: true,
  goals: true,
  notes: true,
  actionItems: true,
  contracts: true,
  assessments: true,
  meetings: true,
  deliverables: true,
};

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
      <span className="text-[10px] text-muted-foreground">Page {page} of {totalPages}</span>
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
  stepFourLabel,
}: {
  currentScreen: 1 | 2 | 3 | 4;
  stepFourLabel: string;
}) {
  const steps = [
    { id: 1, label: "Source Key" },
    { id: 2, label: "Client Mapping" },
    { id: 3, label: "Object Selection" },
    { id: 4, label: stepFourLabel },
  ] as const;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
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
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  return (
    <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {value}
    </span>
  );
}

function ProgressPill({
  status,
  succeeded,
  total,
}: {
  status: ClientMigrationProgress["objects"][MigrationObjectType]["status"];
  succeeded: number;
  total: number;
}) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning">
        <Loader2 className="h-3 w-3 animate-spin" />
        running
      </span>
    );
  }

  if (status === "skipped") {
    return <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">skipped</span>;
  }

  if (status === "pending") {
    return <span className="rounded-full bg-surface-raised px-2 py-0.5 text-[10px] font-medium text-muted-foreground">pending</span>;
  }

  if (status === "success") {
    return <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">✓ {succeeded}{total > 0 ? ` / ${total}` : ""}</span>;
  }

  if (status === "partial") {
    return <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning">⚠ {succeeded}/{total}</span>;
  }

  return <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">✗ {succeeded}/{total}</span>;
}

export function TenantMigrationWorkspace({
  copy = DEFAULT_COPY,
}: {
  copy?: TenantMigrationWorkspaceCopy;
}) {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [currentScreen, setCurrentScreen] = useState<1 | 2 | 3 | 4>(1);
  const [sourceApiKey, setSourceApiKey] = useState("");
  const [destinationApiKey] = useState(() => window.sessionStorage.getItem("sp_api_key") || "");
  const [sourceClients, setSourceClients] = useState<MigrationClient[]>([]);
  const [destinationClients, setDestinationClients] = useState<MigrationClient[]>([]);
  const [clientMappings, setClientMappings] = useState<ClientMapping[]>([]);
  const [selectedObjects, setSelectedObjects] = useState<SelectedObjects>(DEFAULT_SELECTED_OBJECTS);
  const [destinationUsers, setDestinationUsers] = useState<DestinationUserOption[]>([]);
  const [selectedAssessmentEvaluatorUserId, setSelectedAssessmentEvaluatorUserId] = useState("");
  const [loadingDestinationUsers, setLoadingDestinationUsers] = useState(false);
  const [destinationUsersError, setDestinationUsersError] = useState<string | null>(null);
  const [actionItemAssigneeEmail, setActionItemAssigneeEmail] = useState(
    "tulsie.narine+lmx-demo-halo@scalepad.com"
  );
  const [migrationProgress, setMigrationProgress] = useState<ClientMigrationProgress[]>([]);
  const [migrationResult, setMigrationResult] = useState<MigrationResult | null>(null);
  const [loadingClients, setLoadingClients] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [migrationRunning, setMigrationRunning] = useState(false);
  const [screenOneError, setScreenOneError] = useState<string | null>(null);
  const [finalTab, setFinalTab] = useState<FinalTab>("summary");

  const [sourceSearch, setSourceSearch] = useState("");
  const [matchedOnly, setMatchedOnly] = useState(false);
  const [sourcePage, setSourcePage] = useState(1);
  const [errorClientFilter, setErrorClientFilter] = useState("all");
  const [errorObjectFilter, setErrorObjectFilter] = useState("all");

  useEffect(() => {
    setSourcePage(1);
  }, [sourceSearch, matchedOnly]);

  const mappedClients = useMemo(
    () => clientMappings.filter((mapping) => !mapping.skip && mapping.dstClientId && mapping.dstClientName),
    [clientMappings]
  );

  const mappedCount = mappedClients.length;
  const skippedCount = clientMappings.filter((mapping) => mapping.skip || !mapping.dstClientId).length;

  const mappingLookup = useMemo(() => new Map(clientMappings.map((mapping) => [mapping.srcClientId, mapping])), [clientMappings]);

  const filteredSourceClients = useMemo(() => {
    const query = sourceSearch.trim().toLowerCase();
    return sourceClients.filter((client) => {
      const mapping = mappingLookup.get(client.id);
      const isMatched = Boolean(mapping?.dstClientId && !mapping.skip);
      return (!query || client.name.toLowerCase().includes(query)) && (!matchedOnly || isMatched);
    });
  }, [mappingLookup, matchedOnly, sourceClients, sourceSearch]);

  const sourceTotalPages = Math.max(1, Math.ceil(filteredSourceClients.length / PAGE_SIZE));
  const pagedSourceClients = filteredSourceClients.slice((sourcePage - 1) * PAGE_SIZE, sourcePage * PAGE_SIZE);

  const destinationOptions = useMemo(
    () => [...destinationClients].sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [destinationClients]
  );
  const destinationLookup = useMemo(() => new Map(destinationClients.map((client) => [client.id, client])), [destinationClients]);
  const selectedObjectCount = useMemo(
    () => Object.values(selectedObjects).filter(Boolean).length,
    [selectedObjects]
  );
  const requiresAssigneeEmail = selectedObjects.actionItems;
  const hasValidAssigneeEmail = actionItemAssigneeEmail.trim().length > 0;
  const hasAssessmentEvaluator = selectedAssessmentEvaluatorUserId.trim().length > 0;

  useEffect(() => {
    if (!selectedObjects.assessments || !destinationApiKey || destinationUsers.length > 0) return;
    let cancelled = false;
    setLoadingDestinationUsers(true);
    setDestinationUsersError(null);
    fetchDestinationUsers(destinationApiKey)
      .then((users) => {
        if (cancelled) return;
        setDestinationUsers(users);
        setSelectedAssessmentEvaluatorUserId((current) => current || users[0]?.id || "");
      })
      .catch((error) => {
        if (cancelled) return;
        setDestinationUsersError(error instanceof Error ? error.message : "Could not load destination users.");
      })
      .finally(() => {
        if (!cancelled) setLoadingDestinationUsers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [destinationApiKey, destinationUsers.length, selectedObjects.assessments]);

  const completedClients = useMemo(
    () =>
      migrationProgress.filter((client) =>
        Object.values(client.objects).every((objectProgress) => objectProgress.status !== "pending" && objectProgress.status !== "running")
      ).length,
    [migrationProgress]
  );

  const errorClientOptions = useMemo(() => {
    if (!migrationResult) return [];
    return Array.from(new Set(migrationResult.errors.map((entry) => entry.clientName))).sort((a, b) => a.localeCompare(b));
  }, [migrationResult]);

  const filteredErrors = useMemo(() => {
    if (!migrationResult) return [];
    return migrationResult.errors.filter((entry) => {
      if (errorClientFilter !== "all" && entry.clientName !== errorClientFilter) return false;
      if (errorObjectFilter !== "all" && entry.objectType !== errorObjectFilter) return false;
      return true;
    });
  }, [migrationResult, errorClientFilter, errorObjectFilter]);

  const loadClients = async () => {
    if (!destinationApiKey) {
      setScreenOneError("Destination tenant is not connected. Please return to the marketplace and reconnect your API key.");
      return;
    }

    if (!sourceApiKey.trim()) {
      setScreenOneError("Source Tenant API Key is required.");
      return;
    }

    setLoadingClients(true);
    setLoadingMessage("Connecting to source tenant...");
    setScreenOneError(null);

    try {
      const [destination, source] = await Promise.all([
        fetchAllClients(destinationApiKey),
        fetchAllClients(sourceApiKey.trim()),
      ]);

      setDestinationClients(destination);
      setSourceClients(source);
      setClientMappings(autoMatchClientMappings(source, destination));
      setCurrentScreen(2);
      toast({
        title: "Clients loaded",
        description: `Loaded ${source.length} source clients and ${destination.length} destination clients.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load clients";
      if (message.includes("403")) {
        setScreenOneError("Invalid API key or insufficient permissions.");
      } else {
        setScreenOneError(message);
      }
    } finally {
      setLoadingClients(false);
      setLoadingMessage("");
    }
  };

  const updateMapping = (srcClientId: string, value: string) => {
    setClientMappings((prev) =>
      prev.map((mapping) => {
        if (mapping.srcClientId !== srcClientId) return mapping;
        if (value === "skip") {
          return {
            ...mapping,
            dstClientId: null,
            dstClientName: null,
            skip: true,
          };
        }

        const destinationClient = destinationLookup.get(value);
        return {
          ...mapping,
          dstClientId: destinationClient?.id || null,
          dstClientName: destinationClient?.name || null,
          skip: false,
        };
      })
    );
  };

  const handleGoToObjectSelection = () => {
    if (mappedCount === 0) {
      toast({
        title: "Map at least one client",
        description: "You need at least one source client mapped to a destination client before you can continue.",
        variant: "destructive",
      });
      return;
    }
    setCurrentScreen(3);
  };

  const handleStartMigration = async () => {
    if (selectedObjectCount === 0) {
      toast({
        title: "Select at least one object type",
        description: "Choose what should be migrated before starting the migration.",
        variant: "destructive",
      });
      return;
    }

    const selectedMappings = mappedClients;
    const initialProgress = selectedMappings.map((mapping) => buildInitialClientProgress(mapping));
    setMigrationProgress(initialProgress);
    setMigrationResult(null);
    setFinalTab("summary");
    setMigrationRunning(true);
    setCurrentScreen(4);

    try {
      const result = await runTenantMigration({
        sourceApiKey: sourceApiKey.trim(),
        destinationApiKey,
        mappings: selectedMappings,
        selectedObjects,
        sourceClients,
        destinationClients,
        actionItemAssigneeEmail: selectedObjects.actionItems ? actionItemAssigneeEmail.trim() || null : null,
        assessmentEvaluatorUserId: selectedObjects.assessments ? selectedAssessmentEvaluatorUserId : null,
        onClientProgress: (clientIndex, progress) => {
          setMigrationProgress((prev) => prev.map((item, index) => (index === clientIndex ? progress : item)));
        },
      });
      setMigrationResult(result);
      toast({
        title: copy.completeToastTitle,
        description: `${result.clientSummaries.length} clients ${copy.finalSummaryVerb}, ${result.totalCreated} objects created, ${result.totalFailures} failures.`,
      });
    } catch (error) {
      toast({
        title: copy.stoppedToastTitle,
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setMigrationRunning(false);
    }
  };

  const exportErrorsAsCsv = () => {
    if (!filteredErrors.length) return;

    const header = ["Client", "Object Type", "Record", "Error Code", "Error Detail", "Request Payload"];
    const rows = filteredErrors.map((entry) => [
      entry.clientName,
      entry.objectType,
      entry.recordName,
      entry.errorCode,
      entry.errorDetail,
      entry.requestPayloadText || "",
    ]);

    const csv = [header, ...rows]
      .map((row) =>
        row
          .map((value) => `"${String(value).replace(/"/g, '""')}"`)
          .join(",")
      )
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = copy.errorCsvFilename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportDebugAsJson = () => {
    if (!migrationResult) return;

    const payload = {
      errors: filteredErrors.map((entry) => ({
        client: entry.clientName,
        objectType: entry.objectType,
        record: entry.recordName,
        errorCode: Number(entry.errorCode) || entry.errorCode,
        errorDetail: entry.errorDetail,
        endpoint: entry.endpoint || null,
        method: entry.method || null,
        request_payload: entry.requestPayload ?? null,
        resolved_email: entry.resolvedEmail ?? null,
        resolved_user_id: entry.resolvedUserId ?? null,
        source_user_id: entry.sourceUserId ?? null,
      })),
      diagnostics: (migrationResult.debugDiagnostics || []).map((entry) => ({
        client: entry.clientName,
        objectType: entry.objectType,
        record: entry.recordName,
        resolved_email: entry.resolvedEmail ?? null,
        resolved_user_id: entry.resolvedUserId ?? null,
        source_user_id: entry.sourceUserId ?? null,
        note: entry.note ?? null,
      })),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = copy.debugJsonFilename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const resetWorkflow = () => {
    setCurrentScreen(1);
    setSourceApiKey("");
    setSourceClients([]);
    setDestinationClients([]);
    setClientMappings([]);
    setSelectedObjects(DEFAULT_SELECTED_OBJECTS);
    setActionItemAssigneeEmail("");
    setMigrationProgress([]);
    setMigrationResult(null);
    setMigrationRunning(false);
    setScreenOneError(null);
    setFinalTab("summary");
    setSourceSearch("");
    setSourcePage(1);
    setErrorClientFilter("all");
    setErrorObjectFilter("all");
  };

  const renderScreenOne = () => (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-6">
        <div className="mb-2 flex items-center gap-3">
          <span className="text-4xl">🔄</span>
          <div>
            <h2 className="font-heading text-2xl font-bold text-foreground">{copy.title}</h2>
            <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
          </div>
        </div>
      </div>

      <div className="space-y-5">
        <div className="rounded-lg border border-success/20 bg-success/5 p-4">
          <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Destination Tenant (connected)
          </label>
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 rounded-full bg-success" />
            <span className="font-mono text-sm text-foreground">{maskApiKey(destinationApiKey)}</span>
          </div>
        </div>

        <div>
          <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Source Tenant API Key
          </label>
          <input
            type="password"
            value={sourceApiKey}
            onChange={(event) => setSourceApiKey(event.target.value)}
            placeholder="sp_live_••••••••••••••••"
            className="h-11 w-full rounded-md border border-border bg-surface-raised px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {screenOneError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {screenOneError}
          </div>
        )}

        {loadingClients && (
          <div className="flex items-center gap-2 text-sm text-warning">
            <Loader2 className="h-4 w-4 animate-spin" />
            {loadingMessage}
          </div>
        )}

        <button
          onClick={loadClients}
          disabled={loadingClients}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loadingClients && <Loader2 className="h-4 w-4 animate-spin" />}
          Connect & Load Clients
        </button>
      </div>
    </div>
  );

  const renderScreenTwo = () => (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-heading text-lg font-bold text-foreground">Client Mapping</h3>
            <p className="text-sm text-muted-foreground">
              {mappedCount} of {sourceClients.length} source clients mapped · {skippedCount} set to Do Not Migrate
            </p>
          </div>
          {mappedCount === 0 && (
            <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
              <TriangleAlert className="h-4 w-4" />
              Map at least one client to continue.
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-[560px] flex-col rounded-lg border border-border bg-card">
        <div className="space-y-3 border-b border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h4 className="font-heading text-sm font-bold text-foreground">Source -&gt; Destination Tenant Mapping</h4>
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                {filteredSourceClients.length}{matchedOnly ? ` of ${sourceClients.length}` : ""}
              </span>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={matchedOnly}
                onChange={(event) => setMatchedOnly(event.target.checked)}
                className="h-3.5 w-3.5 rounded border-border accent-primary"
              />
              Show matched clients only
            </label>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={sourceSearch}
              onChange={(event) => setSourceSearch(event.target.value)}
              placeholder="Search source clients to map..."
              className="h-9 w-full rounded-md border border-border bg-surface-raised pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {pagedSourceClients.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">No source clients found.</p>
          ) : (
            pagedSourceClients.map((client) => {
              const mapping = mappingLookup.get(client.id);
              const mappedDestination =
                mapping?.dstClientId && !mapping.skip ? destinationLookup.get(mapping.dstClientId) || null : null;

              return (
                <div key={client.id} className="border-b border-border px-4 py-3">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{client.name}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <StatusBadge value={client.lifecycle} />
                        <span className="text-[11px] text-muted-foreground">{client.num_hardware_assets} assets</span>
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <div className="min-w-0">
                      <select
                        value={mapping?.skip || !mapping?.dstClientId ? "skip" : mapping.dstClientId}
                        onChange={(event) => updateMapping(client.id, event.target.value)}
                        aria-label={`Destination tenant for ${client.name}`}
                        className={classNames(
                          "h-9 w-full min-w-0 rounded-md border px-2.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary",
                          mappedDestination ? "border-primary/30 bg-primary/10" : "border-border bg-surface-raised"
                        )}
                      >
                        <option value="skip">Do Not Migrate</option>
                        {destinationOptions.map((destinationClient) => (
                          <option key={destinationClient.id} value={destinationClient.id}>
                            {destinationClient.name}
                          </option>
                        ))}
                      </select>
                      {mappedDestination && (
                        <p className="mt-1 truncate text-[10px] text-muted-foreground">
                          {client.num_hardware_assets} assets → {mappedDestination.num_hardware_assets} assets
                        </p>
                      )}
                    </div>
                    {!mappedDestination && (
                      <span
                        title="This source client is currently set to Do Not Migrate."
                        aria-label="This source client is currently set to Do Not Migrate."
                        className="rounded-full bg-muted p-1.5 text-muted-foreground"
                      >
                        <Ban className="h-4 w-4" aria-hidden="true" />
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <Pagination page={sourcePage} totalPages={sourceTotalPages} onPageChange={setSourcePage} />
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
          onClick={handleGoToObjectSelection}
          disabled={mappedCount === 0}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next: Select Objects
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  const renderScreenThree = () => (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-5">
        <h3 className="font-heading text-lg font-bold text-foreground">What would you like to migrate?</h3>
        <p className="text-sm text-muted-foreground">{mappedCount} source clients will be migrated</p>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{selectedObjectCount} object types selected</span>
        <div className="flex gap-3 text-xs">
          <button
            onClick={() => setSelectedObjects({ ...DEFAULT_SELECTED_OBJECTS })}
            className="text-primary transition-colors hover:text-primary/80"
          >
            Select All
          </button>
          <button
            onClick={() =>
              setSelectedObjects({
                initiatives: false,
                goals: false,
                notes: false,
                actionItems: false,
                contracts: false,
                assessments: false,
                meetings: false,
                deliverables: false,
              })
            }
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Deselect All
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {OBJECT_OPTIONS.map((option) => {
          return (
          <label
            key={option.key}
            className={classNames(
              "flex items-start gap-3 rounded-md border border-border bg-surface-raised px-4 py-3 transition-colors",
              "cursor-pointer hover:border-primary/40"
            )}
          >
            <input
              type="checkbox"
              checked={selectedObjects[option.key]}
              onChange={(event) =>
                setSelectedObjects((prev) => ({
                  ...prev,
                  [option.key]: event.target.checked,
                }))
              }
              className="mt-0.5 accent-primary"
            />
            <span className="text-sm text-foreground">{option.label}</span>
          </label>
          );
        })}
      </div>

      {selectedObjects.actionItems && (
        <div className="mt-5 rounded-md border border-border bg-surface-raised p-4">
          <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Fallback Assignee Email for Action Items
          </label>
          <input
            type="email"
            value={actionItemAssigneeEmail}
            onChange={(event) => setActionItemAssigneeEmail(event.target.value)}
            placeholder="name@company.com"
            required
            className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      )}

      {selectedObjects.assessments && (
        <div className="mt-5 rounded-md border border-primary/30 bg-primary/5 p-4">
          <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Destination user for assessments
          </label>
          <p className="mb-3 text-xs text-muted-foreground">
            Choose the user recorded as the primary evaluator on new destination assessments.
          </p>
          <select
            aria-label="Destination user for assessments"
            value={selectedAssessmentEvaluatorUserId}
            onChange={(event) => setSelectedAssessmentEvaluatorUserId(event.target.value)}
            disabled={loadingDestinationUsers || destinationUsers.length === 0}
            className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">
              {loadingDestinationUsers ? "Loading destination users…" : "Select a destination user"}
            </option>
            {destinationUsers.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}{user.email ? ` · ${user.email}` : ""}
              </option>
            ))}
          </select>
          {destinationUsersError && <p className="mt-2 text-xs text-destructive">{destinationUsersError}</p>}
          {!loadingDestinationUsers && !destinationUsersError && destinationUsers.length === 0 && (
            <p className="mt-2 text-xs text-warning">No destination users were returned by the API.</p>
          )}
        </div>
      )}

      <div className="mt-5 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
        Relationships between objects (e.g. Goals linked to Initiatives, Action Items linked to Meetings) will only be preserved if both linked object types are selected.
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          onClick={() => setCurrentScreen(2)}
          className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-raised"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <button
          onClick={handleStartMigration}
          disabled={selectedObjectCount === 0 || (requiresAssigneeEmail && !hasValidAssigneeEmail) || (selectedObjects.assessments && !hasAssessmentEvaluator)}
          className="inline-flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {copy.runButtonLabel}
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  const renderLiveProgress = () => (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-heading text-lg font-bold text-foreground">{copy.runningTitle}</h3>
            <p className="text-sm text-muted-foreground">Client {Math.min(completedClients + 1, Math.max(migrationProgress.length, 1))} of {migrationProgress.length}</p>
          </div>
          <div className="rounded-full bg-warning/15 px-3 py-1 text-xs font-medium text-warning">
            Running
          </div>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-surface-raised">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${migrationProgress.length ? (completedClients / migrationProgress.length) * 100 : 0}%` }}
          />
        </div>
      </div>

      <div className="space-y-3">
        {migrationProgress.map((client) => {
          const activeClient = Object.values(client.objects).some((objectProgress) => objectProgress.status === "running");
          return (
            <div key={client.clientId} className="rounded-lg border border-border bg-card p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  {activeClient && <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-warning" />}
                  <h4 className="text-sm font-medium text-foreground">
                    {client.clientName} → {client.destinationClientName}
                  </h4>
                </div>
              </div>

              <div className="space-y-2">
                {(Object.keys(client.objects) as MigrationObjectType[]).map((type) => {
                  const objectProgress = client.objects[type];
                  return (
                    <div key={type} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                      <span className="text-xs text-foreground">{OBJECT_LABELS[type]}</span>
                      <ProgressPill
                        status={objectProgress.status}
                        succeeded={objectProgress.succeeded}
                        total={objectProgress.total}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderFinalReport = () => {
    if (!migrationResult) return null;

    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="font-heading text-lg font-bold text-foreground">{copy.completeHeading}</h3>
              <p className="text-sm text-muted-foreground">
                {migrationResult.clientSummaries.length} clients migrated · {migrationResult.totalCreated} objects created · {migrationResult.totalFailures} failures
              </p>
            </div>
            <CheckCircle2 className="h-6 w-6 text-success" />
          </div>

          <div className="flex gap-2 border-t border-border pt-4">
            <button
              onClick={() => setFinalTab("summary")}
              className={classNames(
                "rounded-md px-3 py-2 text-xs font-medium",
                finalTab === "summary" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Summary
            </button>
            <button
              onClick={() => setFinalTab("errors")}
              className={classNames(
                "rounded-md px-3 py-2 text-xs font-medium",
                finalTab === "errors" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Error Log
            </button>
            <button
              onClick={() => setFinalTab("relationships")}
              className={classNames(
                "rounded-md px-3 py-2 text-xs font-medium",
                finalTab === "relationships" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Relationship Log
            </button>
          </div>
        </div>

        {finalTab === "summary" && (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="border-b border-border bg-surface-raised text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Client</th>
                    {OBJECT_OPTIONS.map((option) => (
                      <th key={option.key} className="px-4 py-3 font-medium">{OBJECT_LABELS[option.key]}</th>
                    ))}
                    <th className="px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {migrationResult.clientSummaries.map((summary) => (
                    <tr key={`${summary.clientName}-${summary.destinationClientName}`} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-3 text-foreground">
                        {summary.clientName} → {summary.destinationClientName}
                      </td>
                      {OBJECT_OPTIONS.map((option) => {
                        const count = summary.counts[option.key];
                        const complete = count.total === 0 || count.succeeded === count.total;
                        return (
                          <td key={option.key} className="px-4 py-3">
                            <span className={classNames("font-medium", complete ? "text-success" : "text-warning")}>
                              {complete ? "✓" : "⚠"} {count.succeeded}{count.total ? `/${count.total}` : ""}
                            </span>
                          </td>
                        );
                      })}
                      <td className="px-4 py-3">
                        <span
                          className={classNames(
                            "rounded-full px-2 py-0.5 text-[10px] font-medium",
                            summary.status === "Complete" && "bg-success/15 text-success",
                            summary.status === "Partial" && "bg-warning/15 text-warning",
                            summary.status === "Failed" && "bg-destructive/15 text-destructive"
                          )}
                        >
                          {summary.status === "Complete" ? "✓ Complete" : summary.status === "Partial" ? "⚠ Partial" : "✗ Failed"}
                        </span>
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
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap gap-3">
                <select
                  value={errorClientFilter}
                  onChange={(event) => setErrorClientFilter(event.target.value)}
                  className="h-9 rounded-md border border-border bg-surface-raised px-3 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="all">All Clients</option>
                  {errorClientOptions.map((clientName) => (
                    <option key={clientName} value={clientName}>
                      {clientName}
                    </option>
                  ))}
                </select>

                <select
                  value={errorObjectFilter}
                  onChange={(event) => setErrorObjectFilter(event.target.value)}
                  className="h-9 rounded-md border border-border bg-surface-raised px-3 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="all">All Object Types</option>
                  {OBJECT_OPTIONS.map((option) => (
                    <option key={option.key} value={OBJECT_LABELS[option.key]}>
                      {OBJECT_LABELS[option.key]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={exportErrorsAsCsv}
                  disabled={filteredErrors.length === 0}
                  className="rounded-md border border-border px-3 py-2 text-xs text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Export Error Log as CSV
                </button>
                <button
                  onClick={exportDebugAsJson}
                  disabled={filteredErrors.length === 0}
                  className="rounded-md border border-border px-3 py-2 text-xs text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Debug Export
                </button>
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-xs">
                  <thead className="border-b border-border bg-surface-raised text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">Client</th>
                      <th className="px-4 py-3 font-medium">Object Type</th>
                      <th className="px-4 py-3 font-medium">Record</th>
                      <th className="px-4 py-3 font-medium">Error Code</th>
                      <th className="px-4 py-3 font-medium">Error Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredErrors.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                          No errors match the current filters.
                        </td>
                      </tr>
                    ) : (
                      filteredErrors.map((entry, index) => (
                        <tr key={`${entry.clientName}-${entry.objectType}-${entry.recordName}-${index}`} className="border-b border-border last:border-b-0">
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
                  {migrationResult.relationshipLog.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                        No relationships were created or logged for this migration.
                      </td>
                    </tr>
                  ) : (
                    migrationResult.relationshipLog.map((entry: RelationshipLogEntry, index: number) => (
                      <tr key={`${entry.clientName}-${entry.type}-${index}`} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-3 text-foreground">{entry.clientName}</td>
                        <td className="px-4 py-3 text-foreground">{entry.type}</td>
                        <td className="px-4 py-3 text-foreground">{entry.sourceRecord}</td>
                        <td className="px-4 py-3 text-foreground">{entry.targetRecord}</td>
                        <td className="px-4 py-3">
                          <span
                            className={classNames(
                              "rounded-full px-2 py-0.5 text-[10px] font-medium",
                              entry.status === "created" && "bg-success/15 text-success",
                              entry.status === "failed" && "bg-destructive/15 text-destructive",
                              entry.status === "skipped" && "bg-warning/15 text-warning"
                            )}
                          >
                            {entry.status}
                          </span>
                          {entry.detail && <p className="mt-1 text-[10px] text-muted-foreground">{entry.detail}</p>}
                        </td>
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
            className="rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-raised"
          >
            {copy.runAgainLabel}
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

  return (
    <div className="space-y-4">
      <StepIndicator currentScreen={currentScreen} stepFourLabel={copy.stepFourLabel} />

      {currentScreen === 1 && renderScreenOne()}
      {currentScreen === 2 && renderScreenTwo()}
      {currentScreen === 3 && renderScreenThree()}
      {currentScreen === 4 && (
        <>
          {migrationRunning && renderLiveProgress()}
          {!migrationRunning && migrationResult && renderFinalReport()}
          {!migrationRunning && !migrationResult && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive">
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Migration did not produce a final report.
              </div>
              <button
                onClick={() => setCurrentScreen(3)}
                className="inline-flex items-center gap-2 rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/10"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to object selection
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
