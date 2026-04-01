import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertTriangle, ChevronDown, ChevronRight, ChevronLeft, Loader2,
  Check, X, Download, RotateCcw,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  fetchAllClients,
  runClientCleanup,
  getSectionConfigs,
  type CleanupClient,
  type SectionType,
  type ClientProgress,
  type CleanupError,
} from "@/lib/cleanup-api";

const PAGE_SIZE = 8;

const SECTION_KEYS: SectionType[] = [
  "initiatives", "goals", "meetings", "actionItems",
  "notes", "assessments", "contracts", "deliverables",
];

const SECTION_LABELS: Record<SectionType, string> = {
  initiatives: "Initiatives",
  goals: "Goals",
  meetings: "Meetings",
  actionItems: "Action Items",
  notes: "Notes",
  assessments: "Assessments",
  contracts: "Contracts",
  deliverables: "Deliverables",
};

type Step = 1 | 2 | "running" | "complete";

export function ClientCleanUpWorkspace() {
  const navigate = useNavigate();
  const apiKey = window.sessionStorage.getItem("scalepad_api_key") || "";

  // Step 1 state
  const [clients, setClients] = useState<CleanupClient[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);

  // Step 2 state
  const [selectedSections, setSelectedSections] = useState<Record<SectionType, boolean>>(
    () => Object.fromEntries(SECTION_KEYS.map((k) => [k, true])) as Record<SectionType, boolean>
  );
  const [clientListOpen, setClientListOpen] = useState(false);

  // Confirmation modal
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  // Overall state
  const [currentStep, setCurrentStep] = useState<Step>(1);

  // Progress state
  const [progressList, setProgressList] = useState<ClientProgress[]>([]);
  const [currentClientIdx, setCurrentClientIdx] = useState(0);
  const [errors, setErrors] = useState<CleanupError[]>([]);
  const errorsRef = useRef<CleanupError[]>([]);
  const [errorsOpen, setErrorsOpen] = useState(false);

  // Fetch clients on mount
  useEffect(() => {
    if (!apiKey) return;
    loadClients();
  }, [apiKey]);

  const loadClients = async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const result = await fetchAllClients(apiKey);
      setClients(result);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to load clients");
    } finally {
      setLoading(false);
    }
  };

  // Filtered + paginated clients
  const filtered = useMemo(() => {
    if (!search.trim()) return clients;
    const q = search.toLowerCase();
    return clients.filter((c) => c.name.toLowerCase().includes(q));
  }, [clients, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageClients = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  useEffect(() => { setPage(0); }, [search]);

  // Selection helpers
  const toggleClient = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAllPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      pageClients.forEach((c) => next.add(c.id));
      return next;
    });
  };

  const deselectAllPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      pageClients.forEach((c) => next.delete(c.id));
      return next;
    });
  };

  const toggleSection = (key: SectionType) => {
    setSelectedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const selectAllSections = () => {
    setSelectedSections(
      Object.fromEntries(SECTION_KEYS.map((k) => [k, true])) as Record<SectionType, boolean>
    );
  };

  const deselectAllSections = () => {
    setSelectedSections(
      Object.fromEntries(SECTION_KEYS.map((k) => [k, false])) as Record<SectionType, boolean>
    );
  };

  const selectedClients = useMemo(
    () => clients.filter((c) => selectedIds.has(c.id)),
    [clients, selectedIds]
  );

  const selectedSectionNames = SECTION_KEYS.filter((k) => selectedSections[k]).map(
    (k) => SECTION_LABELS[k]
  );

  // ---- Deletion execution ----
  const runDeletion = useCallback(async () => {
    setShowConfirm(false);
    setCurrentStep("running");
    setErrors([]);
    errorsRef.current = [];

    const initial: ClientProgress[] = selectedClients.map((c) => ({
      clientId: c.id,
      clientName: c.name,
      sections: getSectionConfigs().map((s) => ({
        type: s.type,
        label: s.label,
        status: selectedSections[s.type] ? "pending" : "skipped",
        deleted: 0,
        total: 0,
      })),
    }));
    setProgressList(initial);

    for (let i = 0; i < selectedClients.length; i++) {
      setCurrentClientIdx(i);
      const client = selectedClients[i];

      await runClientCleanup(
        apiKey,
        client,
        selectedSections,
        (prog) => {
          setProgressList((prev) => {
            const next = [...prev];
            next[i] = prog;
            return next;
          });
        },
        (error) => {
          errorsRef.current = [...errorsRef.current, error];
          setErrors([...errorsRef.current]);
        }
      );
    }

    setCurrentStep("complete");
  }, [apiKey, selectedClients, selectedSections]);

  // ---- CSV export ----
  const exportErrorsCsv = () => {
    const header = "Client,Section,Record ID,Error Code,Error Detail\n";
    const rows = errors
      .map(
        (e) =>
          `"${e.clientName}","${e.section}","${e.recordId}","${e.errorCode}","${e.errorDetail.replace(/"/g, '""')}"`
      )
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cleanup-errors-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---- Summary stats ----
  const totalDeleted = progressList.reduce(
    (sum, cp) => sum + cp.sections.reduce((s, sec) => s + sec.deleted, 0),
    0
  );
  const totalFailures = errors.length;

  // ---- No API key ----
  if (!apiKey) {
    return (
      <div className="bg-card border border-border rounded-lg p-8 text-center">
        <p className="text-muted-foreground">
          Please set your ScalePad API key in Settings before using Client Clean Up.
        </p>
      </div>
    );
  }

  // =================== RENDER ===================

  return (
    <div className="bg-card border border-border rounded-lg p-6 space-y-6">
      {/* Step indicator */}
      {(currentStep === 1 || currentStep === 2) && (
        <div className="flex items-center gap-3 text-sm">
          <span
            className={`px-3 py-1 rounded-full font-medium ${
              currentStep === 1
                ? "bg-primary/15 text-primary"
                : "bg-muted text-muted-foreground"
            }`}
          >
            Step 1: Select Clients
          </span>
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
          <span
            className={`px-3 py-1 rounded-full font-medium ${
              currentStep === 2
                ? "bg-primary/15 text-primary"
                : "bg-muted text-muted-foreground"
            }`}
          >
            Step 2: Configure & Run
          </span>
        </div>
      )}

      {/* ===== STEP 1 ===== */}
      {currentStep === 1 && (
        <div className="space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary mr-2" />
              <span className="text-muted-foreground">Loading clients…</span>
            </div>
          ) : fetchError ? (
            <div className="text-center py-12 space-y-3">
              <p className="text-destructive">{fetchError}</p>
              <Button variant="outline" onClick={loadClients}>
                Retry
              </Button>
            </div>
          ) : (
            <>
              {/* Controls */}
              <div className="flex items-center gap-3 flex-wrap">
                <Input
                  placeholder="Search clients…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="max-w-xs"
                />
                <Button variant="ghost" size="sm" onClick={selectAllPage}>
                  Select All
                </Button>
                <Button variant="ghost" size="sm" onClick={deselectAllPage}>
                  Deselect All
                </Button>
                <span className="text-sm text-muted-foreground ml-auto">
                  {selectedIds.size} client{selectedIds.size !== 1 ? "s" : ""} selected
                </span>
              </div>

              {/* Client table */}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>Client Name</TableHead>
                    <TableHead>Lifecycle</TableHead>
                    <TableHead className="text-right">Hardware Assets</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageClients.map((c) => (
                    <TableRow
                      key={c.id}
                      className="cursor-pointer"
                      onClick={() => toggleClient(c.id)}
                    >
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(c.id)}
                          onCheckedChange={() => toggleClient(c.id)}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-xs">
                          {c.lifecycle}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{c.num_hardware_assets}</TableCell>
                    </TableRow>
                  ))}
                  {pageClients.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                        No clients found
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>

              {/* Pagination */}
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Page {page + 1} of {totalPages}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>

              {/* Next */}
              <div className="flex justify-end">
                <Button
                  disabled={selectedIds.size === 0}
                  onClick={() => setCurrentStep(2)}
                >
                  Next <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ===== STEP 2 ===== */}
      {currentStep === 2 && (
        <div className="space-y-6">
          {/* Section selection */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-heading font-bold text-sm">
                  Select what to delete for each selected client
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  All sections are selected by default. Uncheck any you wish to keep.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={selectAllSections}
                  className="text-xs text-primary hover:underline"
                >
                  Select All
                </button>
                <span className="text-muted-foreground">·</span>
                <button
                  onClick={deselectAllSections}
                  className="text-xs text-primary hover:underline"
                >
                  Deselect All
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {SECTION_KEYS.map((key) => (
                <label
                  key={key}
                  className="flex items-center gap-2 cursor-pointer text-sm"
                >
                  <Checkbox
                    checked={selectedSections[key]}
                    onCheckedChange={() => toggleSection(key)}
                  />
                  {SECTION_LABELS[key]}
                </label>
              ))}
            </div>
          </div>

          {/* Warning banner */}
          <div className="flex items-start gap-3 p-4 rounded-lg bg-destructive/10 border border-destructive/30">
            <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <p className="text-sm text-destructive">
              <strong>⚠ This action is permanent and cannot be undone.</strong> All
              selected data will be deleted from ScalePad for the selected clients.
            </p>
          </div>

          {/* Selected clients summary */}
          <Collapsible open={clientListOpen} onOpenChange={setClientListOpen}>
            <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium hover:text-primary transition-colors">
              {clientListOpen ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              {selectedClients.length} client{selectedClients.length !== 1 ? "s" : ""}{" "}
              selected
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <div className="max-h-40 overflow-y-auto rounded border border-border p-3 space-y-1">
                {selectedClients.map((c) => (
                  <p key={c.id} className="text-sm text-foreground">
                    {c.name}
                  </p>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Action buttons */}
          <div className="flex items-center justify-between pt-2">
            <Button variant="ghost" onClick={() => setCurrentStep(1)}>
              <ChevronLeft className="w-4 h-4 mr-1" /> Back
            </Button>
            <Button
              variant="destructive"
              className="px-6 py-2.5 text-base font-semibold"
              disabled={selectedSectionNames.length === 0}
              onClick={() => {
                setConfirmChecked(false);
                setConfirmText("");
                setShowConfirm(true);
              }}
            >
              Delete Selected Data
            </Button>
          </div>
        </div>
      )}

      {/* ===== CONFIRMATION MODAL ===== */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-heading">
              Confirm Permanent Deletion
            </DialogTitle>
            <DialogDescription>
              You are about to permanently delete the following from ScalePad for{" "}
              {selectedClients.length} client{selectedClients.length !== 1 ? "s" : ""}:
            </DialogDescription>
          </DialogHeader>

          <ul className="list-disc pl-6 text-sm space-y-1 my-2">
            {selectedSectionNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p className="text-sm text-destructive font-medium">
            This cannot be undone.
          </p>

          <div className="space-y-4 mt-4">
            <label className="flex items-start gap-2 cursor-pointer text-sm">
              <Checkbox
                checked={confirmChecked}
                onCheckedChange={(v) => setConfirmChecked(v === true)}
                className="mt-0.5"
              />
              I understand this is permanent and cannot be reversed
            </label>

            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Type <span className="font-mono font-bold">DELETE</span> to confirm
              </label>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="DELETE"
                className="max-w-[200px]"
              />
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button variant="ghost" onClick={() => setShowConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="px-6 py-2.5 text-base font-semibold"
              disabled={!confirmChecked || confirmText !== "DELETE"}
              onClick={runDeletion}
            >
              Permanently Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== RUNNING ===== */}
      {currentStep === "running" && (
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
            <h3 className="font-heading font-bold text-sm">
              Deleting data — do not close this window
            </h3>
          </div>

          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              Client {currentClientIdx + 1} of {selectedClients.length}
            </p>
            <Progress
              value={((currentClientIdx + 1) / selectedClients.length) * 100}
              className="h-2"
            />
          </div>

          <div className="space-y-3 max-h-[50vh] overflow-y-auto">
            {progressList.map((cp, idx) => (
              <ClientProgressCard key={cp.clientId} progress={cp} active={idx === currentClientIdx} />
            ))}
          </div>
        </div>
      )}

      {/* ===== COMPLETE ===== */}
      {currentStep === "complete" && (
        <div className="space-y-6">
          <h3 className="font-heading font-bold text-lg flex items-center gap-2">
            <Check className="w-5 h-5 text-success" /> Clean Up Complete
          </h3>
          <p className="text-sm text-muted-foreground">
            {selectedClients.length} client{selectedClients.length !== 1 ? "s" : ""}{" "}
            processed · {totalDeleted} records deleted · {totalFailures} failure
            {totalFailures !== 1 ? "s" : ""}
          </p>

          {/* Results table */}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  {SECTION_KEYS.filter((k) => selectedSections[k]).map((k) => (
                    <TableHead key={k} className="text-center">
                      {SECTION_LABELS[k]}
                    </TableHead>
                  ))}
                  <TableHead className="text-center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {progressList.map((cp) => {
                  const hasAnyFail = cp.sections.some(
                    (s) => s.status === "failed" || s.status === "partial"
                  );
                  const allSkipped = cp.sections.every(
                    (s) => s.status === "skipped" || s.status === "success"
                  );
                  return (
                    <TableRow key={cp.clientId}>
                      <TableCell className="font-medium">{cp.clientName}</TableCell>
                      {SECTION_KEYS.filter((k) => selectedSections[k]).map((k) => {
                        const sec = cp.sections.find((s) => s.type === k);
                        if (!sec || sec.status === "skipped") {
                          return (
                            <TableCell key={k} className="text-center text-muted-foreground text-xs">
                              —
                            </TableCell>
                          );
                        }
                        return (
                          <TableCell key={k} className="text-center text-xs">
                            {sec.status === "success" ? (
                              <span className="text-success">✓ {sec.deleted}</span>
                            ) : sec.status === "partial" ? (
                              <span className="text-warning">
                                ⚠ {sec.deleted}/{sec.total}
                              </span>
                            ) : sec.status === "failed" ? (
                              <span className="text-destructive">✗</span>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-center">
                        {hasAnyFail ? (
                          <Badge variant="outline" className="text-warning border-warning">
                            ⚠ Partial
                          </Badge>
                        ) : allSkipped ? (
                          <Badge variant="outline" className="text-success border-success">
                            ✓ Complete
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-success border-success">
                            ✓ Complete
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Error log */}
          {errors.length > 0 && (
            <Collapsible open={errorsOpen} onOpenChange={setErrorsOpen}>
              <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium text-destructive hover:underline">
                {errorsOpen ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
                {errors.length} error{errors.length !== 1 ? "s" : ""}
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-2">
                <div className="overflow-x-auto max-h-60 border border-border rounded">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Client</TableHead>
                        <TableHead>Section</TableHead>
                        <TableHead>Record ID</TableHead>
                        <TableHead>Code</TableHead>
                        <TableHead>Detail</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {errors.map((e, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{e.clientName}</TableCell>
                          <TableCell className="text-xs">{e.section}</TableCell>
                          <TableCell className="text-xs font-mono">{e.recordId}</TableCell>
                          <TableCell className="text-xs">{e.errorCode}</TableCell>
                          <TableCell className="text-xs max-w-[200px] truncate">
                            {e.errorDetail}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <Button variant="outline" size="sm" onClick={exportErrorsCsv}>
                  <Download className="w-4 h-4 mr-1" /> Export Error Log as CSV
                </Button>
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                setSelectedIds(new Set());
                setSelectedSections(
                  Object.fromEntries(SECTION_KEYS.map((k) => [k, true])) as Record<SectionType, boolean>
                );
                setProgressList([]);
                setErrors([]);
                errorsRef.current = [];
                setCurrentStep(1);
              }}
            >
              <RotateCcw className="w-4 h-4 mr-1" /> Run Another Clean Up
            </Button>
            <Button onClick={() => navigate("/marketplace")}>Done</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Sub-component: per-client progress card ----

function ClientProgressCard({
  progress,
  active,
}: {
  progress: ClientProgress;
  active: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 space-y-2 ${
        active
          ? "border-primary/40 bg-primary/5"
          : "border-border bg-card"
      }`}
    >
      <p className="font-medium text-sm">{progress.clientName}</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
        {progress.sections.map((sec) => (
          <div key={sec.type} className="flex items-center gap-1.5">
            <SectionStatusIcon status={sec.status} />
            <span
              className={
                sec.status === "skipped"
                  ? "text-muted-foreground"
                  : "text-foreground"
              }
            >
              {sec.label}
            </span>
            {sec.status === "success" && (
              <span className="text-success ml-auto">{sec.deleted}</span>
            )}
            {sec.status === "partial" && (
              <span className="text-warning ml-auto">
                {sec.deleted}/{sec.total}
              </span>
            )}
            {sec.status === "running" && (
              <span className="text-muted-foreground ml-auto">
                {sec.deleted}/{sec.total}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "pending":
      return <span className="w-3 h-3 rounded-full bg-muted-foreground/30" />;
    case "running":
      return <Loader2 className="w-3 h-3 animate-spin text-primary" />;
    case "success":
      return <Check className="w-3 h-3 text-success" />;
    case "partial":
      return <AlertTriangle className="w-3 h-3 text-warning" />;
    case "failed":
      return <X className="w-3 h-3 text-destructive" />;
    case "skipped":
      return <span className="w-3 h-3 rounded-full bg-muted" />;
    default:
      return null;
  }
}
