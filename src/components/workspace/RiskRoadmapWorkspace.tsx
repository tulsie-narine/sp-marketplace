import { useState, useEffect, useMemo, useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  CalendarIcon,
  Plus,
  Trash2,
} from "lucide-react";
import {
  type PortfolioClient,
  type ClientRisk,
  type ActionItem,
  type InitStepStatus,
  type InitiativeForm,
  fetchClientsHealth,
  fetchRisksSummary,
  mergePortfolioData,
  fetchClientRisks,
  fetchClientActionItems,
  createActionItem,
  deployInitiative,
} from "@/lib/risk-roadmap-api";
import {
  listRoadmapSyncTasks,
  runRoadmapSync,
  saveRoadmapSyncTask,
  deleteRoadmapSyncTask,
  setRoadmapSyncSchedule,
  type RoadmapSyncConfig,
} from "@/lib/risk-roadmap-sync-api";

const PAGE_SIZE = 10;

interface RiskWorkTracking {
  actionItems: number;
  initiatives: number;
  treatmentPlanDetails: string[];
}

// --- Risk level badge ---
function RiskBadge({ level }: { level: string }) {
  const l = level?.toLowerCase() || "";
  const colors: Record<string, string> = {
    severe: "bg-[rgba(239,68,68,0.12)] text-[#ef4444] border-[rgba(239,68,68,0.2)]",
    high: "bg-[rgba(245,158,11,0.12)] text-[#f59e0b] border-[rgba(245,158,11,0.2)]",
    medium: "bg-[rgba(79,110,247,0.12)] text-[#4f6ef7] border-[rgba(79,110,247,0.2)]",
    low: "bg-[rgba(34,197,94,0.12)] text-[#22c55e] border-[rgba(34,197,94,0.2)]",
  };
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wide border ${colors[l] || "bg-muted text-muted-foreground border-border"}`}>
      {level || "Unknown"}
    </span>
  );
}

function TrendIcon({ value }: { value: number }) {
  if (value > 0) return <span className="flex items-center gap-0.5 text-[#22c55e] text-xs"><TrendingUp className="w-3 h-3" />+{value}</span>;
  if (value < 0) return <span className="flex items-center gap-0.5 text-[#ef4444] text-xs"><TrendingDown className="w-3 h-3" />{value}</span>;
  return <span className="flex items-center gap-0.5 text-muted-foreground text-xs"><Minus className="w-3 h-3" />0</span>;
}

function GapBar({ current, target, max = 25 }: { current: number; target: number; max?: number }) {
  const gap = current - target;
  const pct = Math.min(100, (Math.abs(gap) / max) * 100);
  const color = gap >= 15 ? "#ef4444" : gap >= 5 ? "#f59e0b" : "#22c55e";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-border overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="text-xs font-mono" style={{ color }}>{gap}</span>
    </div>
  );
}

// =====================
// Main component
// =====================
export function RiskRoadmapWorkspace() {
  const apiKey =
    window.sessionStorage.getItem("sp_api_key") ||
    window.sessionStorage.getItem("scalepad_api_key") ||
    "";

  // --- Portfolio state ---
  const [portfolio, setPortfolio] = useState<PortfolioClient[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeScreen, setActiveScreen] = useState<"portfolio" | "workspace">("portfolio");

  // --- Client workspace state ---
  const [selectedClient, setSelectedClient] = useState<PortfolioClient | null>(null);
  const [clientRisks, setClientRisks] = useState<ClientRisk[]>([]);
  const [clientActionItems, setClientActionItems] = useState<ActionItem[]>([]);
  const [riskWorkTracking, setRiskWorkTracking] = useState<Record<number, RiskWorkTracking>>({});
  const [risksLoading, setRisksLoading] = useState(false);
  const [risksError, setRisksError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState("All");
  const [treatmentFilter, setTreatmentFilter] = useState("All");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [sortBy, setSortBy] = useState("highest");
  const [viewMode, setViewMode] = useState<"table" | "heatmap">("table");
  const [selectedRiskIds, setSelectedRiskIds] = useState<Set<number>>(new Set());

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerRisks, setDrawerRisks] = useState<ClientRisk[]>([]);
  const [drawerTab, setDrawerTab] = useState<"actionItem" | "initiative">("actionItem");
  const [scheduleTaskCount, setScheduleTaskCount] = useState(0);

  // Pagination
  const [portfolioPage, setPortfolioPage] = useState(0);
  const [portfolioSearch, setPortfolioSearch] = useState("");
  const [riskPage, setRiskPage] = useState(0);

  // =====================
  // PORTFOLIO FETCH
  // =====================
  const loadPortfolio = useCallback(async () => {
    if (!apiKey) {
      setLoadError("No API key found. Please set your ScalePad API key first.");
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [health, summaries] = await Promise.all([
        fetchClientsHealth(apiKey),
        fetchRisksSummary(apiKey),
      ]);
      setPortfolio(mergePortfolioData(health, summaries));
    } catch (e: any) {
      setLoadError(e.message || "Failed to load portfolio data");
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    loadPortfolio();
  }, [loadPortfolio]);

  // --- Portfolio derived ---
  const filteredPortfolio = useMemo(() => {
    let list = [...portfolio];
    if (portfolioSearch) {
      const q = portfolioSearch.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q));
    }
    // Default sort: severe desc, then high desc
    list.sort((a, b) => b.severe - a.severe || b.high - a.high);
    return list;
  }, [portfolio, portfolioSearch]);

  const portfolioPages = Math.ceil(filteredPortfolio.length / PAGE_SIZE);
  const portfolioSlice = filteredPortfolio.slice(portfolioPage * PAGE_SIZE, (portfolioPage + 1) * PAGE_SIZE);

  const stats = useMemo(() => {
    const severeClients = portfolio.filter((c) => c.severe > 0).length;
    const decliningCompliance = portfolio.filter((c) => c.trend_30 < 0).length;
    const totalSevereHigh = portfolio.reduce((s, c) => s + c.severe + c.high, 0);
    const lowCompletion = portfolio.filter((c) => c.action_item_pct < 50).length;
    return { severeClients, decliningCompliance, totalSevereHigh, lowCompletion };
  }, [portfolio]);

  // =====================
  // CLIENT SELECT
  // =====================
  const selectClient = useCallback(async (client: PortfolioClient) => {
    setSelectedClient(client);
    setActiveScreen("workspace");
    setRisksLoading(true);
    setRisksError(null);
    setRiskWorkTracking({});
    setSelectedRiskIds(new Set());
    setRiskPage(0);
    try {
      const [risks, items] = await Promise.all([
        fetchClientRisks(apiKey, client.id),
        fetchClientActionItems(apiKey, client.id),
      ]);
      setClientRisks(risks);
      setClientActionItems(items);
    } catch (e: any) {
      setRisksError(e.message || "Failed to load risks");
    } finally {
      setRisksLoading(false);
    }
  }, [apiKey]);

  // --- Risk filtering ---
  const categories = useMemo(() => {
    const set = new Set(clientRisks.map((r) => r.risk_category).filter(Boolean));
    return Array.from(set).sort();
  }, [clientRisks]);

  const filteredRisks = useMemo(() => {
    let list = [...clientRisks];
    if (statusFilter !== "All") list = list.filter((r) => r.status === statusFilter);
    if (treatmentFilter !== "All") list = list.filter((r) => r.treatment === treatmentFilter);
    if (categoryFilter !== "All") list = list.filter((r) => r.risk_category === categoryFilter);
    switch (sortBy) {
      case "highest": list.sort((a, b) => b.current_risk_score - a.current_risk_score); break;
      case "gap": list.sort((a, b) => (b.current_risk_score - b.target_risk_score) - (a.current_risk_score - a.target_risk_score)); break;
      case "newest": list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()); break;
      case "oldest": list.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()); break;
    }
    return list;
  }, [clientRisks, statusFilter, treatmentFilter, categoryFilter, sortBy]);

  const riskPages = Math.ceil(filteredRisks.length / PAGE_SIZE);
  const riskSlice = filteredRisks.slice(riskPage * PAGE_SIZE, (riskPage + 1) * PAGE_SIZE);

  // --- Heatmap ---
  const heatmapData = useMemo(() => {
    const grid: Map<string, ClientRisk[]> = new Map();
    filteredRisks.forEach((r) => {
      const x = Math.max(1, Math.min(5, Math.round(r.inherent_risk_score / 4) || 1));
      const y = Math.max(1, Math.min(5, Math.round(r.current_risk_score / 4) || 1));
      const key = `${x}-${y}`;
      grid.set(key, [...(grid.get(key) || []), r]);
    });
    return grid;
  }, [filteredRisks]);

  // --- Drawer open ---
  const openDrawerForRisks = (risks: ClientRisk[]) => {
    setDrawerRisks(risks);
    setDrawerTab("actionItem");
    setDrawerOpen(true);
  };

  const openBulkBundle = () => {
    const selected = clientRisks.filter((r) => selectedRiskIds.has(r.id));
    openDrawerForRisks(selected.length > 0 ? selected : filteredRisks);
  };

  const openDrawerForActionItems = (items: ActionItem[]) => {
    const source = items.length > 0 ? items : clientActionItems;
    const risks: ClientRisk[] = source.map((item, index) => ({
      id: Number(item.id) || -(index + 1),
      code: `AI-${item.id}`,
      name: item.weakness_name,
      description: "",
      owner: null,
      status: item.status,
      department: "",
      risk_category: "Action Item",
      treatment: "",
      business_impact: "",
      inherent_risk_score: 0,
      inherent_risk_label: item.priority,
      current_risk_score: 0,
      current_risk_label: item.priority,
      target_risk_score: 0,
      target_risk_label: item.priority,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    openDrawerForRisks(risks);
  };

  const trackRiskWork = useCallback(
    (risks: ClientRisk[], kind: "actionItem" | "initiative", detail: string) => {
      setRiskWorkTracking((prev) => {
        const next = { ...prev };
        for (const risk of risks) {
          const current = next[risk.id] || {
            actionItems: 0,
            initiatives: 0,
            treatmentPlanDetails: [],
          };
          next[risk.id] = {
            actionItems: current.actionItems + (kind === "actionItem" ? 1 : 0),
            initiatives: current.initiatives + (kind === "initiative" ? 1 : 0),
            treatmentPlanDetails: [detail, ...current.treatmentPlanDetails].slice(0, 6),
          };
        }
        return next;
      });
    },
    []
  );

  // =====================
  // RENDER
  // =====================

  if (!apiKey) {
    return (
      <div className="bg-card border border-border rounded-lg p-8 text-center">
        <ShieldAlert className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">
          No API key found. Please set your ScalePad API key on the Settings page.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Tabs
        value={activeScreen}
        onValueChange={(v) => setActiveScreen(v as "portfolio" | "workspace")}
      >
        <TabsList className="bg-[#111520]">
          <TabsTrigger value="portfolio">Portfolio Overview</TabsTrigger>
          <TabsTrigger value="workspace" disabled={!selectedClient}>
            Client Workspace
          </TabsTrigger>
        </TabsList>

        <TabsContent value="portfolio">
          <PortfolioScreen
            loading={loading}
            error={loadError}
            onRetry={loadPortfolio}
            stats={stats}
            clients={portfolioSlice}
            totalClients={filteredPortfolio.length}
            page={portfolioPage}
            totalPages={portfolioPages}
            onPageChange={setPortfolioPage}
            search={portfolioSearch}
            onSearchChange={(v) => { setPortfolioSearch(v); setPortfolioPage(0); }}
            onSelectClient={selectClient}
          />
        </TabsContent>

        <TabsContent value="workspace">
          {selectedClient && (
            <WorkspaceScreen
              client={selectedClient}
              risks={riskSlice}
              allFilteredRisks={filteredRisks}
              loading={risksLoading}
              error={risksError}
              onBack={() => setActiveScreen("portfolio")}
              statusFilter={statusFilter}
              onStatusFilter={setStatusFilter}
              treatmentFilter={treatmentFilter}
              onTreatmentFilter={setTreatmentFilter}
              categoryFilter={categoryFilter}
              onCategoryFilter={setCategoryFilter}
              categories={categories}
              sortBy={sortBy}
              onSortBy={setSortBy}
              viewMode={viewMode}
              onViewMode={setViewMode}
              selectedIds={selectedRiskIds}
              onToggleSelect={(id) => {
                setSelectedRiskIds((prev) => {
                  const next = new Set(prev);
                  next.has(id) ? next.delete(id) : next.add(id);
                  return next;
                });
              }}
              onPlanRisk={(r) => openDrawerForRisks([r])}
              onBulkBundle={openBulkBundle}
              onPlanActionItems={openDrawerForActionItems}
              onTaskCountChange={setScheduleTaskCount}
              scheduleTaskCount={scheduleTaskCount}
              page={riskPage}
              totalPages={riskPages}
              onPageChange={setRiskPage}
              heatmapData={heatmapData}
              clientActionItems={clientActionItems}
              riskWorkTracking={riskWorkTracking}
            />
          )}
        </TabsContent>
      </Tabs>

      {/* Planning Drawer */}
      <PlanningDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        risks={drawerRisks}
        clientId={selectedClient?.id || ""}
        clientTenantId={selectedClient?.tenant_id || ""}
        apiKey={apiKey}
        tab={drawerTab}
        onTabChange={setDrawerTab}
        onActionItemCreated={(risks, detail) => trackRiskWork(risks, "actionItem", detail)}
        onInitiativeCreated={(risks, detail) => trackRiskWork(risks, "initiative", detail)}
      />
    </div>
  );
}

// ==============================================
// SCREEN 1 - PORTFOLIO
// ==============================================

interface PortfolioScreenProps {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  stats: { severeClients: number; decliningCompliance: number; totalSevereHigh: number; lowCompletion: number };
  clients: PortfolioClient[];
  totalClients: number;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
  search: string;
  onSearchChange: (s: string) => void;
  onSelectClient: (c: PortfolioClient) => void;
}

function PortfolioScreen({
  loading, error, onRetry, stats, clients, totalClients,
  page, totalPages, onPageChange, search, onSearchChange, onSelectClient,
}: PortfolioScreenProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-primary mr-3" />
        <span className="text-sm text-muted-foreground">Loading portfolio data...</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="bg-card border border-border rounded-lg p-8 text-center space-y-3">
        <AlertTriangle className="w-6 h-6 text-[#ef4444] mx-auto" />
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button size="sm" onClick={onRetry}><RefreshCw className="w-3 h-3 mr-1" />Retry</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-heading font-bold">Portfolio Risk Overview</h2>
        <p className="text-xs text-muted-foreground">{totalClients} clients - sorted by risk severity</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Severe Risk Clients" value={stats.severeClients} color="#ef4444" />
        <StatCard label="Declining Compliance" value={stats.decliningCompliance} color="#f59e0b" />
        <StatCard label="Severe+High Risks" value={stats.totalSevereHigh} color="#ef4444" />
        <StatCard label="<50% Completion" value={stats.lowCompletion} color="#f59e0b" />
      </div>

      {/* Search */}
      <Input
        placeholder="Search clients..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="max-w-xs bg-[#111520] border-border"
      />

      {/* Table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-[#111520]">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Client</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Risk Level</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Severe</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">High</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Medium</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Compliance</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">30d Trend</th>
              <th className="text-center px-3 py-2 font-medium text-muted-foreground">AI %</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr
                key={c.id}
                className="border-b border-border hover:bg-[#181d2e] cursor-pointer transition-colors"
                onClick={() => onSelectClient(c)}
              >
                <td className="px-3 py-2.5 font-medium">{c.name}</td>
                <td className="px-3 py-2.5"><RiskBadge level={c.risk_level} /></td>
                <td className="px-3 py-2.5 text-center font-mono text-xs">{c.severe}</td>
                <td className="px-3 py-2.5 text-center font-mono text-xs">{c.high}</td>
                <td className="px-3 py-2.5 text-center font-mono text-xs">{c.medium}</td>
                <td className="px-3 py-2.5 text-center font-mono text-xs">{c.compliance_score.toFixed(1)}</td>
                <td className="px-3 py-2.5 text-center"><TrendIcon value={c.trend_30} /></td>
                <td className="px-3 py-2.5 text-center font-mono text-xs">{c.action_item_pct}%</td>
                <td className="px-3 py-2.5 text-right">
                  <span className="text-xs text-primary hover:underline">View -&gt;</span>
                </td>
              </tr>
            ))}
            {clients.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground text-sm">No clients found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Page {page + 1} of {totalPages}</span>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => onPageChange(page - 1)}>&lt;- Prev</Button>
            <Button size="sm" variant="ghost" disabled={page >= totalPages - 1} onClick={() => onPageChange(page + 1)}>Next -&gt;</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <p className="text-2xl font-heading font-bold" style={{ color }}>{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{label}</p>
    </div>
  );
}

// ==============================================
// SCREEN 2 - CLIENT WORKSPACE
// ==============================================

interface WorkspaceScreenProps {
  client: PortfolioClient;
  risks: ClientRisk[];
  allFilteredRisks: ClientRisk[];
  clientActionItems: ActionItem[];
  riskWorkTracking: Record<number, RiskWorkTracking>;
  loading: boolean;
  error: string | null;
  onBack: () => void;
  statusFilter: string;
  onStatusFilter: (v: string) => void;
  treatmentFilter: string;
  onTreatmentFilter: (v: string) => void;
  categoryFilter: string;
  onCategoryFilter: (v: string) => void;
  categories: string[];
  sortBy: string;
  onSortBy: (v: string) => void;
  viewMode: "table" | "heatmap";
  onViewMode: (v: "table" | "heatmap") => void;
  selectedIds: Set<number>;
  onToggleSelect: (id: number) => void;
  onPlanRisk: (r: ClientRisk) => void;
  onBulkBundle: () => void;
  onPlanActionItems: (items: ActionItem[]) => void;
  onTaskCountChange: (count: number) => void;
  scheduleTaskCount: number;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
  heatmapData: Map<string, ClientRisk[]>;
}

function WorkspaceScreen({
  client, risks, allFilteredRisks, clientActionItems, riskWorkTracking, loading, error, onBack,
  statusFilter, onStatusFilter, treatmentFilter, onTreatmentFilter,
  categoryFilter, onCategoryFilter, categories, sortBy, onSortBy,
  viewMode, onViewMode, selectedIds, onToggleSelect, onPlanRisk,
  onBulkBundle, page, totalPages, onPageChange, heatmapData,
  onPlanActionItems,
  onTaskCountChange,
  scheduleTaskCount,
}: WorkspaceScreenProps) {
  const [expandedRiskIds, setExpandedRiskIds] = useState<Set<number>>(new Set());
  const [workspaceTab, setWorkspaceTab] = useState<"risks" | "actionItems">("risks");
  const [scheduleRequest, setScheduleRequest] = useState(0);
  const [scheduleSource, setScheduleSource] = useState<RoadmapSyncConfig["sourceType"]>("action_items");
  const [scheduleSelection, setScheduleSelection] = useState<string[]>([]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-primary mr-3" />
        <span className="text-sm text-muted-foreground">Loading risks...</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="bg-card border border-border rounded-lg p-8 text-center space-y-3">
        <AlertTriangle className="w-6 h-6 text-[#ef4444] mx-auto" />
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  const statuses = ["All", "Not Assessed", "Assessment in progress", "Needs Remediation", "Assessed", "Remediated", "Closed"];
  const treatments = ["All", "Avoid", "Reduce", "Transfer", "Share", "Accept"];

  const getExistingActionItems = (risk: ClientRisk) => {
    const code = risk.code.toLowerCase();
    const name = risk.name.toLowerCase();
    return clientActionItems.filter((item) => {
      const text = item.weakness_name.toLowerCase();
      return text.includes(code) || text.includes(name);
    });
  };

  const getTrackerSummary = (risk: ClientRisk) => {
    const existingActionItems = getExistingActionItems(risk);
    const tracked = riskWorkTracking[risk.id];
    return {
      existingActionItems,
      actionItemsCount: existingActionItems.length + (tracked?.actionItems || 0),
      initiativesCount: tracked?.initiatives || 0,
      totalLinkedCount: existingActionItems.length + (tracked?.actionItems || 0) + (tracked?.initiatives || 0),
      treatmentPlanDetails: tracked?.treatmentPlanDetails || [],
    };
  };

  const toggleExpanded = (riskId: number) => {
    setExpandedRiskIds((prev) => {
      const next = new Set(prev);
      next.has(riskId) ? next.delete(riskId) : next.add(riskId);
      return next;
    });
  };

  return (
    <Tabs value={workspaceTab} onValueChange={(value) => setWorkspaceTab(value as "risks" | "actionItems")}>
      <TabsList className="bg-[#111520]">
        <TabsTrigger value="risks">Risk Registry</TabsTrigger>
        <TabsTrigger value="actionItems">Action Items</TabsTrigger>
      </TabsList>
      <TabsContent value="risks">
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1" />All Clients
        </Button>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-heading font-bold">{client.name}</h2>
          <RiskBadge level={client.risk_level} />
          <span className="text-xs text-muted-foreground font-mono">Score: {client.overall_risk_score}</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <FilterSelect label="Status" value={statusFilter} options={statuses} onChange={onStatusFilter} />
        <FilterSelect label="Treatment" value={treatmentFilter} options={treatments} onChange={onTreatmentFilter} />
        <FilterSelect label="Category" value={categoryFilter} options={["All", ...categories]} onChange={onCategoryFilter} />
        <FilterSelect label="Sort" value={sortBy} options={[
          { value: "highest", label: "Highest Risk" },
          { value: "gap", label: "Largest Gap" },
          { value: "newest", label: "Newest" },
          { value: "oldest", label: "Oldest" },
        ]} onChange={onSortBy} />
        <Button size="sm" onClick={onBulkBundle}>Plan selected / all</Button>
        <Button size="sm" variant="outline" onClick={() => { setScheduleSource("risks"); setScheduleSelection(Array.from(selectedIds).map(String)); setScheduleRequest((request) => request + 1); }}>Configure sync ({scheduleTaskCount})</Button>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant={viewMode === "table" ? "default" : "ghost"} onClick={() => onViewMode("table")}>Table</Button>
          <Button size="sm" variant={viewMode === "heatmap" ? "default" : "ghost"} onClick={() => onViewMode("heatmap")}>Heatmap</Button>
        </div>
      </div>

      {selectedIds.size >= 2 && (
        <div className="bg-primary/10 border border-primary/20 rounded-lg px-4 py-2 flex items-center justify-between">
          <span className="text-sm">{selectedIds.size} risks selected</span>
          <Button size="sm" onClick={onBulkBundle}>Bundle into Initiative {"->"}</Button>
        </div>
      )}

      {viewMode === "table" ? (
        <>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-[#111520]">
                  <th className="px-3 py-2 w-8"></th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Code</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Risk Name</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Owner</th>
                  <th className="text-center px-3 py-2 font-medium text-muted-foreground">Current</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Treatment</th>
                  <th className="text-center px-3 py-2 font-medium text-muted-foreground">Linked</th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {risks.map((r) => {
                  const expanded = expandedRiskIds.has(r.id);
                  const tracker = getTrackerSummary(r);
                  return (
                    <>
                      <tr
                        key={r.id}
                        className="border-b border-border hover:bg-[#181d2e] transition-colors cursor-pointer"
                        onClick={() => toggleExpanded(r.id)}
                      >
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(r.id)}
                            onChange={() => onToggleSelect(r.id)}
                            className="rounded border-border"
                          />
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.code}</td>
                        <td className="px-3 py-2 font-medium max-w-[260px] truncate">{r.name}</td>
                        <td className="px-3 py-2 text-xs">{r.status}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{r.owner?.name || "-"}</td>
                        <td className="px-3 py-2 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <span className="text-xs font-mono">{r.current_risk_score}</span>
                            <RiskBadge level={r.current_risk_label} />
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs">{r.treatment || "-"}</td>
                        <td className="px-3 py-2 text-center">
                          <LinkedWorkBadge count={tracker.totalLinkedCount} />
                        </td>
                        <td className="px-3 py-2 text-right">
                          {expanded ? (
                            <ChevronDown className="w-4 h-4 text-muted-foreground inline-block" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-muted-foreground inline-block" />
                          )}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-b border-border bg-[#111520]">
                          <td colSpan={9} className="px-4 py-4">
                            <div className="grid gap-4 md:grid-cols-2">
                              <DetailBlock label="Category" value={r.risk_category || "-"} />
                              <DetailBlock label="Target / Gap" value={`${r.target_risk_score} target • ${r.current_risk_score - r.target_risk_score} gap`} />
                              <DetailBlock label="Treatment Option" value={r.treatment || "-"} />
                              <div>
                                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Linked Work</p>
                                <div className="flex flex-wrap gap-2">
                                  <StatusPill label="Action Items" value={tracker.actionItemsCount} />
                                  <StatusPill label="Initiatives" value={tracker.initiativesCount} />
                                </div>
                              </div>
                              <div className="md:col-span-2">
                                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Existing Controls / Action Items</p>
                                {tracker.existingActionItems.length > 0 ? (
                                  <div className="space-y-2">
                                    {tracker.existingActionItems.map((item) => (
                                      <div key={item.id} className="rounded-md border border-border bg-background px-3 py-2">
                                        <div className="flex items-center justify-between gap-2">
                                          <p className="text-sm">{item.weakness_name}</p>
                                          <span className="text-[11px] text-muted-foreground">{item.status}</span>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-sm text-muted-foreground">No existing action items matched to this risk yet.</p>
                                )}
                              </div>
                              <div className="md:col-span-2">
                                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Treatment Plan Details</p>
                                <div className="space-y-2 rounded-md border border-border bg-background px-3 py-3">
                                  {tracker.treatmentPlanDetails.length > 0 ? (
                                    tracker.treatmentPlanDetails.map((detail, idx) => (
                                      <p key={`${r.id}-detail-${idx}`} className="text-sm text-foreground">{detail}</p>
                                    ))
                                  ) : (
                                    <p className="text-sm text-muted-foreground">No treatment plan notes recorded yet.</p>
                                  )}
                                </div>
                              </div>
                              <div className="md:col-span-2">
                                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Risk Summary</p>
                                <div className="space-y-2 rounded-md border border-border bg-background px-3 py-3">
                                  <p className="text-sm text-foreground">{r.description || "No description provided."}</p>
                                  <p className="text-sm text-muted-foreground">{r.business_impact || "No business impact provided."}</p>
                                </div>
                              </div>
                              <div className="md:col-span-2 flex justify-end">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-primary text-xs"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onPlanRisk(r);
                                  }}
                                >
                                  Plan {"->"}
                                </Button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
                {risks.length === 0 && (
                  <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground text-sm">No risks found</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Page {page + 1} of {totalPages} ({allFilteredRisks.length} risks)</span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => onPageChange(page - 1)}>&lt;- Prev</Button>
                <Button size="sm" variant="ghost" disabled={page >= totalPages - 1} onClick={() => onPageChange(page + 1)}>Next -&gt;</Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <HeatmapView data={heatmapData} />
      )}
    </div>
      </TabsContent>
      <TabsContent value="actionItems" forceMount>
        <ActionItemsView client={client} actionItems={clientActionItems} onPlanActionItems={onPlanActionItems} scheduleRequest={scheduleRequest} scheduleSource={scheduleSource} scheduleSelection={scheduleSelection} onTaskCountChange={onTaskCountChange} />
      </TabsContent>
    </Tabs>
  );
}

function ActionItemsView({ client, actionItems, onPlanActionItems, scheduleRequest, scheduleSource, scheduleSelection, onTaskCountChange }: { client: PortfolioClient; actionItems: ActionItem[]; onPlanActionItems: (items: ActionItem[]) => void; scheduleRequest: number; scheduleSource: RoadmapSyncConfig["sourceType"]; scheduleSelection: string[]; onTaskCountChange: (count: number) => void }) {
  const [tasks, setTasks] = useState<Array<{ id: string; name: string; config: RoadmapSyncConfig; schedule_enabled: boolean; last_run_at: string | null; last_run_status: string | null; last_run_summary: Record<string, unknown> | null }>>([]);
  const [taskChoice, setTaskChoice] = useState("new");
  const [taskName, setTaskName] = useState("ControlMap to LMX Roadmap");
  const [sourceType, setSourceType] = useState<RoadmapSyncConfig["sourceType"]>("action_items");
  const [destination, setDestination] = useState<RoadmapSyncConfig["destination"]>("initiatives");
  const [horizonMonths, setHorizonMonths] = useState<RoadmapSyncConfig["horizonMonths"]>(6);
  const [onRemoved, setOnRemoved] = useState<RoadmapSyncConfig["onRemoved"]>("decline");
  const [syncAllItems, setSyncAllItems] = useState(true);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("All");
  const [priorityFilter, setPriorityFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMemory, setSelectionMemory] = useState<Set<string>>(new Set());
  const [actionPage, setActionPage] = useState(0);
  const [scheduleDrawerOpen, setScheduleDrawerOpen] = useState(false);

  const statuses = useMemo(() => ["All", ...Array.from(new Set(actionItems.map((item) => item.status).filter(Boolean))).sort()], [actionItems]);
  const priorities = useMemo(() => ["All", ...Array.from(new Set(actionItems.map((item) => item.priority).filter(Boolean))).sort()], [actionItems]);
  const filteredActionItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return actionItems.filter((item) =>
      (statusFilter === "All" || item.status === statusFilter) &&
      (priorityFilter === "All" || item.priority === priorityFilter) &&
      (!query || `${item.id} ${item.weakness_name}`.toLowerCase().includes(query))
    );
  }, [actionItems, priorityFilter, search, statusFilter]);
  const actionPages = Math.ceil(filteredActionItems.length / PAGE_SIZE);
  const actionSlice = filteredActionItems.slice(actionPage * PAGE_SIZE, (actionPage + 1) * PAGE_SIZE);
  useEffect(() => {
    setActionPage((page) => Math.min(page, Math.max(0, actionPages - 1)));
  }, [actionPages]);
  useEffect(() => {
    if (scheduleRequest > 0) {
      setTaskChoice("new");
      setSelectedTaskId(undefined);
      setTaskName("ControlMap to LMX Roadmap");
      setSourceType(scheduleSource);
      setDestination("initiatives");
      setHorizonMonths(6);
      setOnRemoved("decline");
      setSyncAllItems(scheduleSelection.length === 0);
      setScheduleEnabled(false);
      setSelectedIds(new Set(scheduleSelection));
      setSelectionMemory(new Set(scheduleSelection));
      setScheduleDrawerOpen(true);
    }
  }, [scheduleRequest, scheduleSource, scheduleSelection]);

  const loadTasks = useCallback(async () => {
    try {
      const rows = await listRoadmapSyncTasks();
      const matching = rows.filter((task) => task.config?.clientId === client.id);
      setTasks(matching);
      onTaskCountChange(matching.length);
      const current = matching[0];
      if (current) {
        setSelectedTaskId(current.id);
        setTaskChoice(current.id);
        setTaskName(current.name);
        setSourceType(current.config.sourceType || "action_items");
        setDestination(current.config.destination || "initiatives");
        setHorizonMonths(current.config.horizonMonths || 6);
        setOnRemoved(current.config.onRemoved || "decline");
        setSyncAllItems(current.config.syncAll ?? !(current.config.selectedSourceIds || []).length);
        setScheduleEnabled(current.schedule_enabled);
        setSelectedIds(new Set(current.config.selectedSourceIds || []));
      } else {
        setSelectedTaskId(undefined);
        setTaskChoice("new");
        setSyncAllItems(true);
        setScheduleEnabled(false);
        setSelectedIds(new Set());
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load sync tasks.");
    }
  }, [client.id, onTaskCountChange]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  const config: RoadmapSyncConfig = {
    clientId: client.id,
    clientName: client.name,
    sourceType,
    destination,
    onRemoved,
    skipStatuses: ["Not Applicable"],
    horizonMonths,
    syncAll: syncAllItems,
    selectedSourceIds: Array.from(selectedIds),
  };

  const selectTask = (id: string) => {
    setTaskChoice(id);
    if (id === "new") {
      const preservedSelection = selectionMemory.size > 0 ? selectionMemory : selectedIds;
      setSelectedTaskId(undefined);
      setTaskName("ControlMap to LMX Roadmap");
      setSourceType(scheduleSource);
      setDestination("initiatives");
      setHorizonMonths(6);
      setOnRemoved("decline");
      setSyncAllItems(preservedSelection.size === 0);
      setScheduleEnabled(false);
      setSelectedIds(new Set(preservedSelection));
      return;
    }
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task) return;
    setSelectionMemory(new Set(selectedIds));
    setSelectedTaskId(task.id);
    setTaskName(task.name);
    setSourceType(task.config.sourceType || "action_items");
    setDestination(task.config.destination || "initiatives");
    setHorizonMonths(task.config.horizonMonths || 6);
    setOnRemoved(task.config.onRemoved || "decline");
    setSyncAllItems(task.config.syncAll ?? !(task.config.selectedSourceIds || []).length);
    setScheduleEnabled(task.schedule_enabled);
    setSelectedIds(new Set(task.config.selectedSourceIds || []));
  };

  const toggleSelected = (id: string) => {
    setSyncAllItems(false);
    setSelectedIds((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectVisible = () => {
    setSyncAllItems(false);
    setSelectedIds((current) => {
      const next = new Set(current);
      const allSelected = filteredActionItems.length > 0 && filteredActionItems.every((item) => next.has(String(item.id)));
      filteredActionItems.forEach((item) => allSelected ? next.delete(String(item.id)) : next.add(String(item.id)));
      return next;
    });
  };

  const openPlanning = () => {
    const selected = actionItems.filter((item) => selectedIds.has(String(item.id)));
    onPlanActionItems(selected.length > 0 ? selected : filteredActionItems);
  };

  const deleteSelectedTask = async () => {
    if (!selectedTaskId || !window.confirm("Delete this saved sync task? This cannot be undone.")) return;
    setBusy(true);
    setMessage(null);
    try {
      await deleteRoadmapSyncTask(selectedTaskId);
      selectTask("new");
      setMessage("Saved sync task deleted.");
      await loadTasks();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete sync task.");
    } finally {
      setBusy(false);
    }
  };

  const save = async (enabled = scheduleEnabled) => {
    setBusy(true);
    setMessage(null);
    try {
      const task = await saveRoadmapSyncTask({ id: selectedTaskId, name: taskName || "ControlMap to LMX Roadmap", config, scheduleEnabled: enabled });
      setSelectedTaskId(task.id);
      setTaskChoice(task.id);
      setScheduleEnabled(task.schedule_enabled);
      setMessage(enabled ? "Sync task saved and scheduled." : "Sync task saved. Schedule is disabled.");
      await loadTasks();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save sync task.");
    } finally {
      setBusy(false);
    }
  };

  const run = async (mode: "dry-run" | "live") => {
    setBusy(true);
    setMessage(null);
    try {
      let taskId = selectedTaskId;
      if (!taskId) {
        const task = await saveRoadmapSyncTask({ name: taskName || "ControlMap to LMX Roadmap", config, scheduleEnabled: false });
        taskId = task.id;
        setSelectedTaskId(task.id);
        setTaskChoice(task.id);
      }
      const result = await runRoadmapSync(taskId, mode);
      setMessage(`${mode === "live" ? "Live sync" : "Dry run"} ${result.status}: ${JSON.stringify(result.summary)}`);
      await loadTasks();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to run sync.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-heading font-bold text-base">Action Items</h3>
        <p className="text-xs text-muted-foreground mt-1">ControlMap action items for {client.name}, with optional Lifecycle Manager reconciliation.</p>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search action items" className="bg-[#111520] w-full sm:w-64" />
        <FilterSelect label="Status" value={statusFilter} options={statuses} onChange={setStatusFilter} />
        <FilterSelect label="Priority" value={priorityFilter} options={priorities} onChange={setPriorityFilter} />
        <Button size="sm" variant="outline" onClick={selectVisible}>{filteredActionItems.length > 0 && filteredActionItems.every((item) => selectedIds.has(String(item.id))) ? "Clear visible" : "Select visible"}</Button>
        <Button size="sm" onClick={openPlanning}>Plan selected / all</Button>
        <Button size="sm" variant="outline" onClick={() => { setTaskChoice("new"); setSelectedTaskId(undefined); setTaskName("ControlMap to LMX Roadmap"); setSourceType("action_items"); setDestination("initiatives"); setSyncAllItems(selectedIds.size === 0); setScheduleEnabled(false); setScheduleDrawerOpen(true); }}>Configure sync ({tasks.length})</Button>
        <span className="text-xs text-muted-foreground">{filteredActionItems.length} shown · {selectedIds.size} selected</span>
      </div>
      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border bg-[#111520]"><th className="px-3 py-2 w-8"><input type="checkbox" aria-label="Select visible action items" checked={filteredActionItems.length > 0 && filteredActionItems.every((item) => selectedIds.has(String(item.id)))} onChange={selectVisible} /></th><th className="text-left px-3 py-2">ID</th><th className="text-left px-3 py-2">Weakness</th><th className="text-left px-3 py-2">Status</th><th className="text-left px-3 py-2">Priority</th></tr></thead>
          <tbody>
            {actionSlice.map((item) => <tr key={item.id} className="border-b border-border"><td className="px-3 py-2"><input type="checkbox" aria-label={`Select action item ${item.id}`} checked={selectedIds.has(String(item.id))} onChange={() => toggleSelected(String(item.id))} /></td><td className="px-3 py-2 font-mono text-xs text-muted-foreground">{item.id}</td><td className="px-3 py-2">{item.weakness_name}</td><td className="px-3 py-2 text-xs">{item.status}</td><td className="px-3 py-2 text-xs">{item.priority}</td></tr>)}
            {filteredActionItems.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">No action items match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      {actionPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Page {actionPage + 1} of {actionPages} ({filteredActionItems.length} action items)</span>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={actionPage === 0} onClick={() => setActionPage((page) => page - 1)}>&lt;- Prev</Button>
            <Button size="sm" variant="ghost" disabled={actionPage >= actionPages - 1} onClick={() => setActionPage((page) => page + 1)}>Next -&gt;</Button>
          </div>
        </div>
      )}
      <Sheet open={scheduleDrawerOpen} onOpenChange={setScheduleDrawerOpen}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader><SheetTitle>ControlMap to Lifecycle Manager sync</SheetTitle></SheetHeader>
          <div className="border border-border rounded-lg p-4 space-y-3 mt-6">
            <div><h4 className="font-heading font-bold text-sm">Sync task</h4><p className="text-xs text-muted-foreground mt-1">Sync ControlMap risks or action items into Lifecycle Manager initiatives or action items. New records are created and existing records are updated instead of duplicated.</p></div>
        <div className="flex items-end gap-2"><FieldLabel label="Saved task"><Select value={taskChoice} onValueChange={selectTask}><SelectTrigger className="bg-[#111520]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="new">New sync task</SelectItem>{tasks.map((task) => <SelectItem key={task.id} value={task.id}>{task.name}{task.schedule_enabled ? " · scheduled" : ""}</SelectItem>)}</SelectContent></Select></FieldLabel>{selectedTaskId && <Button type="button" variant="outline" className="text-destructive hover:text-destructive" disabled={busy} onClick={deleteSelectedTask}>Delete</Button>}</div>
        <div className="grid gap-3 md:grid-cols-2">
          <FieldLabel label="Task name"><Input value={taskName} onChange={(event) => setTaskName(event.target.value)} className="bg-[#111520]" /></FieldLabel>
          <FieldLabel label="Source"><Select value={sourceType} onValueChange={(value) => setSourceType(value as RoadmapSyncConfig["sourceType"])}><SelectTrigger className="bg-[#111520]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="action_items">ControlMap Action Items</SelectItem><SelectItem value="risks">ControlMap Risk Registry</SelectItem></SelectContent></Select></FieldLabel>
          <FieldLabel label="Lifecycle Manager destination"><Select value={destination} onValueChange={(value) => setDestination(value as RoadmapSyncConfig["destination"])}><SelectTrigger className="bg-[#111520]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="initiatives">Initiatives / Roadmap</SelectItem><SelectItem value="action_items">Action Items</SelectItem></SelectContent></Select></FieldLabel>
          <FieldLabel label="No-date roadmap horizon"><Select value={String(horizonMonths)} onValueChange={(value) => setHorizonMonths(Number(value) as RoadmapSyncConfig["horizonMonths"])}><SelectTrigger className="bg-[#111520]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="3">3 months</SelectItem><SelectItem value="6">6 months</SelectItem><SelectItem value="12">12 months</SelectItem></SelectContent></Select></FieldLabel>
          <FieldLabel label="Removed or skipped source item"><Select value={onRemoved} onValueChange={(value) => setOnRemoved(value as RoadmapSyncConfig["onRemoved"])}><SelectTrigger className="bg-[#111520]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="decline">Decline initiative</SelectItem><SelectItem value="ignore">Leave initiative unchanged</SelectItem></SelectContent></Select></FieldLabel>
        </div>
        <div className="space-y-2 rounded-md border border-border bg-[#111520] p-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Sync scope</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="sync-scope" checked={syncAllItems} onChange={() => setSyncAllItems(true)} />
            <span><span className="font-medium">Sync all current {sourceType === "risks" ? "risk-registry items" : "action items"}</span><span className="block text-xs text-muted-foreground mt-0.5">New records are created and existing Lifecycle Manager records are updated.</span></span>
          </label>
          <label className={`flex items-start gap-2 text-sm ${selectedIds.size === 0 ? "opacity-50" : ""}`}>
            <input type="radio" name="sync-scope" checked={!syncAllItems && selectedIds.size > 0} disabled={selectedIds.size === 0} onChange={() => setSyncAllItems(false)} />
            <span><span className="font-medium">Sync only selected items ({selectedIds.size})</span><span className="block text-xs text-muted-foreground mt-0.5">Uses the items selected in the {sourceType === "risks" ? "Risk Registry" : "Action Items"} table.</span></span>
          </label>
          <label className="flex items-center gap-2 text-sm pt-1"><input type="checkbox" checked={scheduleEnabled} onChange={(event) => setScheduleEnabled(event.target.checked)} /> Enable scheduled sync</label>
        </div>
        {message && <p className="text-xs text-muted-foreground border border-border rounded-md p-2">{message}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => save(false)}>Save task</Button>
          <Button variant="outline" disabled={busy} onClick={() => run("dry-run")}>Preview dry run</Button>
          <Button disabled={busy} onClick={() => run("live")}>Run live sync</Button>
          {selectedTaskId && <Button variant="ghost" disabled={busy} onClick={() => save(!scheduleEnabled)}>{scheduleEnabled ? "Disable schedule" : "Enable schedule"}</Button>}
        </div>
        {tasks[0]?.last_run_at && <p className="text-[11px] text-muted-foreground">Last run: {new Date(tasks[0].last_run_at).toLocaleString()} · {tasks[0].last_run_status || "unknown"}</p>}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
function FilterSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: (string | { value: string; label: string })[];
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[140px] h-8 text-xs bg-[#111520] border-border">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => {
          const val = typeof o === "string" ? o : o.value;
          const lab = typeof o === "string" ? o : o.label;
          return <SelectItem key={val} value={val}>{lab}</SelectItem>;
        })}
      </SelectContent>
    </Select>
  );
}

function HeatmapView({ data }: { data: Map<string, ClientRisk[]> }) {
  const [hoverCell, setHoverCell] = useState<string | null>(null);

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-end gap-1">
        <div className="flex flex-col items-end mr-2 gap-1">
          <span className="text-[10px] text-muted-foreground h-6 flex items-center">Impact</span>
          {[5, 4, 3, 2, 1].map((y) => (
            <span key={y} className="text-[10px] text-muted-foreground h-10 w-4 flex items-center justify-end">{y}</span>
          ))}
        </div>
        <div className="flex-1">
          <div className="grid grid-cols-5 gap-1">
            {[5, 4, 3, 2, 1].map((y) =>
              [1, 2, 3, 4, 5].map((x) => {
                const key = `${x}-${y}`;
                const risks = data.get(key) || [];
                const count = risks.length;
                const bg = count === 0 ? "bg-[#111520]" : count <= 2 ? "bg-[rgba(79,110,247,0.3)]" : count <= 4 ? "bg-[rgba(245,158,11,0.3)]" : "bg-[rgba(239,68,68,0.3)]";
                return (
                  <Popover key={key}>
                    <PopoverTrigger asChild>
                      <button
                        className={`h-10 rounded flex items-center justify-center text-xs font-mono border border-border hover:border-primary/50 transition-colors ${bg}`}
                        onMouseEnter={() => setHoverCell(key)}
                        onMouseLeave={() => setHoverCell(null)}
                      >
                        {count > 0 ? count : ""}
                      </button>
                    </PopoverTrigger>
                    {count > 0 && (
                      <PopoverContent className="w-48 p-2" side="top">
                        <p className="text-xs font-medium mb-1">L{x} x I{y} ({count} risks)</p>
                        {risks.slice(0, 5).map((r) => (
                          <p key={r.id} className="text-xs text-muted-foreground truncate">{r.code}: {r.name}</p>
                        ))}
                        {count > 5 && <p className="text-xs text-muted-foreground">+{count - 5} more</p>}
                      </PopoverContent>
                    )}
                  </Popover>
                );
              })
            )}
          </div>
          <div className="flex justify-between mt-1">
            {[1, 2, 3, 4, 5].map((x) => (
              <span key={x} className="text-[10px] text-muted-foreground flex-1 text-center">{x}</span>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground text-center mt-0.5">Likelihood</p>
        </div>
      </div>
    </div>
  );
}

function LinkedWorkBadge({ count }: { count: number }) {
  return (
    <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
      count > 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
    }`}>
      {count}
    </span>
  );
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  );
}

function StatusPill({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground">
      <span>{label}</span>
      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-[11px] font-semibold text-primary">
        {value}
      </span>
    </span>
  );
}

// ==============================================
// SCREEN 3 - PLANNING DRAWER
// ==============================================

interface PlanningDrawerProps {
  open: boolean;
  onClose: () => void;
  risks: ClientRisk[];
  clientId: string;
  clientTenantId: string;
  apiKey: string;
  tab: "actionItem" | "initiative";
  onTabChange: (t: "actionItem" | "initiative") => void;
  onActionItemCreated: (risks: ClientRisk[], detail: string) => void;
  onInitiativeCreated: (risks: ClientRisk[], detail: string) => void;
}

function PlanningDrawer({ open, onClose, risks, clientId, clientTenantId, apiKey, tab, onTabChange, onActionItemCreated, onInitiativeCreated }: PlanningDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:w-[50vw] sm:max-w-[50vw] overflow-y-auto bg-background border-l border-border p-0">
        <div className="p-6 space-y-4">
          <SheetHeader>
            <SheetTitle className="font-heading">Planning</SheetTitle>
          </SheetHeader>

          {/* Risk pills */}
          <div className="flex flex-wrap gap-1.5">
            {risks.map((r) => (
              <Badge key={r.id} variant="secondary" className="text-xs">
                {r.code}: {r.name}
              </Badge>
            ))}
          </div>

          <Tabs value={tab} onValueChange={(v) => onTabChange(v as any)}>
            <TabsList className="bg-[#111520]">
              <TabsTrigger value="actionItem">Create Action Item</TabsTrigger>
              <TabsTrigger value="initiative">Promote to Initiative</TabsTrigger>
            </TabsList>

            <TabsContent value="actionItem">
              <ActionItemForm risks={risks} clientId={clientId} apiKey={apiKey} onCreated={onActionItemCreated} />
            </TabsContent>
            <TabsContent value="initiative">
              <InitiativePromoteForm
                risks={risks}
                clientId={clientId}
                clientTenantId={clientTenantId}
                apiKey={apiKey}
                onCreated={onInitiativeCreated}
              />
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// --- ACTION ITEM FORM ---

function ActionItemForm({ risks, clientId, apiKey, onCreated }: { risks: ClientRisk[]; clientId: string; apiKey: string; onCreated: (risks: ClientRisk[], detail: string) => void }) {
  const primary = risks[0];
  const gap = primary ? primary.current_risk_score - primary.target_risk_score : 0;

  const mapPriority = (label: string) => {
    const l = label?.toLowerCase();
    if (l === "severe") return "Critical";
    if (l === "high") return "High";
    if (l === "medium") return "Medium";
    return "Low";
  };

  const defaultRoadmap = gap > 15 ? "3 months" : gap > 8 ? "6 months" : "12 months";

  const [form, setForm] = useState({
    weakness_name: risks.map((r) => r.name).join("; "),
    weakness_description: risks.map((r) => r.description).join("\n\n"),
    corrective_action: risks.map((r) => r.business_impact).filter(Boolean).join("\n\n"),
    status: "Not Started",
    priority: mapPriority(primary?.current_risk_label || ""),
    roadmap: defaultRoadmap,
    responsible_person: primary?.owner?.email || "",
    responsible_department: primary?.department || "",
    efforts_in_hours: 0,
    cost: 0,
    currency: "USD",
    planned_start_date: "",
    planned_end_date: "",
    milestones: "",
  });

  const [submitting, setSubmitting] = useState(false);
  const [startDate, setStartDate] = useState<Date>();
  const [endDate, setEndDate] = useState<Date>();

  const submit = async () => {
    if (!form.weakness_name || !form.priority || !form.currency) {
      toast.error("Weakness name, priority, and currency are required.");
      return;
    }
    setSubmitting(true);
    try {
      const created = await createActionItem(apiKey, clientId, {
        ...form,
        efforts_in_hours: form.efforts_in_hours || undefined,
        cost: form.cost || undefined,
        planned_start_date: startDate ? format(startDate, "yyyy-MM-dd") : undefined,
        planned_end_date: endDate ? format(endDate, "yyyy-MM-dd") : undefined,
      });
      const actionLabel = created?.code || created?.id || "new action item";
      onCreated(risks, `Action item ${actionLabel} created by vCISO on ${new Date().toLocaleDateString()}.`);
      toast.success(created?.code ? `Action item created (${created.code})` : "Action item created");
    } catch (e: any) {
      toast.error(e.message || "Failed to create action item");
    } finally {
      setSubmitting(false);
    }
  };

  const set = (key: string, val: any) => setForm((f) => ({ ...f, [key]: val }));

  return (
    <div className="space-y-4 mt-4">
      <h3 className="font-heading font-bold text-sm">Create Action Plan</h3>

      <div className="space-y-3">
        <FieldLabel label="Weakness Name *">
          <Input value={form.weakness_name} onChange={(e) => set("weakness_name", e.target.value)} className="bg-[#111520]" />
        </FieldLabel>
        <FieldLabel label="Weakness Description">
          <Textarea value={form.weakness_description} onChange={(e) => set("weakness_description", e.target.value)} className="bg-[#111520]" rows={3} />
        </FieldLabel>
        <FieldLabel label="Corrective Action">
          <Textarea value={form.corrective_action} onChange={(e) => set("corrective_action", e.target.value)} className="bg-[#111520]" rows={3} />
        </FieldLabel>

        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="Status">
            <Select value={form.status} onValueChange={(v) => set("status", v)}>
              <SelectTrigger className="bg-[#111520]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["Not Started", "In Progress", "Review", "Completed", "Not Applicable"].map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldLabel>
          <FieldLabel label="Priority *">
            <Select value={form.priority} onValueChange={(v) => set("priority", v)}>
              <SelectTrigger className="bg-[#111520]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["Critical", "High", "Medium", "Low"].map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldLabel>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="Roadmap">
            <Select value={form.roadmap} onValueChange={(v) => set("roadmap", v)}>
              <SelectTrigger className="bg-[#111520]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["3 months", "6 months", "12 months"].map((r) => (
                  <SelectItem key={r} value={r}>{r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldLabel>
          <FieldLabel label="Currency *">
            <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
              <SelectTrigger className="bg-[#111520]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["USD", "EUR", "AUD", "CAD", "SEK", "NZD", "SGD", "INR"].map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldLabel>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="Responsible Person">
            <Input value={form.responsible_person} onChange={(e) => set("responsible_person", e.target.value)} placeholder="email" className="bg-[#111520]" />
          </FieldLabel>
          <FieldLabel label="Responsible Department">
            <Input value={form.responsible_department} onChange={(e) => set("responsible_department", e.target.value)} className="bg-[#111520]" />
          </FieldLabel>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="Effort (hours, 0-8)">
            <Input type="number" min={0} max={8} value={form.efforts_in_hours} onChange={(e) => set("efforts_in_hours", Number(e.target.value))} className="bg-[#111520]" />
          </FieldLabel>
          <FieldLabel label="Cost">
            <Input type="number" min={0} value={form.cost} onChange={(e) => set("cost", Number(e.target.value))} className="bg-[#111520]" />
          </FieldLabel>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="Planned Start Date">
            <DateField date={startDate} onChange={setStartDate} />
          </FieldLabel>
          <FieldLabel label="Planned End Date">
            <DateField date={endDate} onChange={setEndDate} />
          </FieldLabel>
        </div>

        <FieldLabel label="Milestones">
          <Textarea value={form.milestones} onChange={(e) => set("milestones", e.target.value)} className="bg-[#111520]" rows={2} />
        </FieldLabel>
      </div>

      <Button onClick={submit} disabled={submitting} className="w-full">
        {submitting && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
        Create Action Item
      </Button>
    </div>
  );
}

// --- INITIATIVE PROMOTE FORM ---

function InitiativePromoteForm({
  risks,
  clientId,
  clientTenantId,
  apiKey,
  onCreated,
}: {
  risks: ClientRisk[];
  clientId: string;
  clientTenantId: string;
  apiKey: string;
  onCreated: (risks: ClientRisk[], detail: string) => void;
}) {
  const primary = risks[0];
  const now = new Date();
  const nextQ = Math.ceil((now.getMonth() + 1) / 3) + 1;
  const defaultYear = nextQ > 4 ? now.getFullYear() + 1 : now.getFullYear();
  const defaultQuarter = nextQ > 4 ? 1 : nextQ;
  const roadmapUrl = clientTenantId
    ? `https://app.scalepad.com/clients/${encodeURIComponent(clientTenantId)}/roadmap`
    : "";

  const mapPriority = (label: string) => {
    const l = label?.toLowerCase();
    if (l === "severe" || l === "high") return "High";
    if (l === "medium") return "Medium";
    return "Low";
  };

  const [name, setName] = useState(risks.length === 1 ? primary?.name || "" : risks.map((r) => r.name).join(" + "));
  const [summary, setSummary] = useState(risks.map((r) => [r.description, r.business_impact].filter(Boolean).join(" - ")).join("\n\n"));
  const [status, setStatus] = useState("Proposed");
  const [priority, setPriority] = useState(mapPriority(primary?.current_risk_label || ""));
  const [year, setYear] = useState(defaultYear);
  const [quarter, setQuarter] = useState(defaultQuarter);

  const [budgetItems, setBudgetItems] = useState<{ label: string; amount: string; cost_type: "Fixed" | "PerAsset" }[]>([]);
  const [recurringItems, setRecurringItems] = useState<{ label: string; amount: string; cost_type: "Fixed" | "PerAsset"; frequency: "Monthly" | "Yearly" }[]>([]);

  const budgetTotal = budgetItems.reduce((s, i) => s + parseFloat(i.amount || "0"), 0);
  const recurringTotal = recurringItems.reduce((s, i) => s + parseFloat(i.amount || "0"), 0);

  const [submitting, setSubmitting] = useState(false);
  const [steps, setSteps] = useState<{ name: string; status: InitStepStatus; error?: string }[]>([
    { name: "Create initiative", status: "pending" },
    { name: "Set status", status: "pending" },
    { name: "Set priority", status: "pending" },
    { name: "Set schedule", status: "pending" },
    { name: "Set budget", status: "pending" },
    { name: "Set recurring", status: "pending" },
  ]);
  const [deployed, setDeployed] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    setDeployed(false);
    setSteps((s) => s.map((st) => ({ ...st, status: "pending" as InitStepStatus, error: undefined })));

    try {
      await deployInitiative(
        apiKey,
        clientId,
        {
          name,
          executive_summary: summary,
          status,
          priority,
          fiscal_quarter: { year, quarter },
          budget_line_items: budgetItems,
          recurring_line_items: recurringItems,
        },
        (stepIdx, stepStatus, err) => {
          setSteps((prev) =>
            prev.map((s, i) => (i === stepIdx ? { ...s, status: stepStatus, error: err } : s))
          );
        }
      );
      setDeployed(true);
      onCreated(risks, `Lifecycle Manager initiative created by vCISO on ${new Date().toLocaleDateString()} to address this risk.`);
      toast.success("Initiative created in Lifecycle Manager");
    } catch (e: any) {
      toast.error(e.message || "Failed to create initiative");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 mt-4">
      <h3 className="font-heading font-bold text-sm">Promote to Roadmap</h3>
      <p className="text-xs text-muted-foreground">This will create a Lifecycle Manager initiative for this client.</p>

      {submitting || deployed ? (
        <div className="space-y-2">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              {s.status === "pending" && <span className="w-4 h-4 rounded-full border border-border" />}
              {s.status === "running" && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
              {s.status === "success" && <CheckCircle2 className="w-4 h-4 text-[#22c55e]" />}
              {s.status === "error" && <XCircle className="w-4 h-4 text-[#ef4444]" />}
              <span className={s.status === "error" ? "text-[#ef4444]" : ""}>{s.name}</span>
              {s.error && <span className="text-xs text-[#ef4444]">- {s.error}</span>}
            </div>
          ))}
          {deployed && (
            <div className="mt-3 p-3 bg-[#22c55e]/10 border border-[#22c55e]/20 rounded-lg text-sm">
              Initiative created.{" "}
              {roadmapUrl ? (
                <a
                  href={roadmapUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  View in ScalePad -&gt;
                </a>
              ) : (
                <span className="text-muted-foreground">View in ScalePad -&gt;</span>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <FieldLabel label="Initiative Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} className="bg-[#111520]" />
          </FieldLabel>
          <FieldLabel label="Executive Summary">
            <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} className="bg-[#111520]" rows={4} />
          </FieldLabel>

          <div className="grid grid-cols-2 gap-3">
            <FieldLabel label="Status">
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="bg-[#111520]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["New", "Proposed", "Approved", "InProgress", "OnHold", "Declined", "Completed"].map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldLabel>
            <FieldLabel label="Priority">
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger className="bg-[#111520]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["None", "Low", "Medium", "High"].map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldLabel>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FieldLabel label="Fiscal Year">
              <Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} className="bg-[#111520]" />
            </FieldLabel>
            <FieldLabel label="Quarter">
              <Select value={`Q${quarter}`} onValueChange={(v) => setQuarter(Number(v.replace("Q", "")))}>
                <SelectTrigger className="bg-[#111520]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4].map((q) => (
                    <SelectItem key={q} value={`Q${q}`}>Q{q}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldLabel>
          </div>

          {/* Budget line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium">One-Time Budget</span>
              <Button size="sm" variant="ghost" className="text-xs h-6" onClick={() => setBudgetItems([...budgetItems, { label: "", amount: "0", cost_type: "Fixed" }])}>
                <Plus className="w-3 h-3 mr-1" />Add
              </Button>
            </div>
            {budgetItems.map((item, idx) => (
              <div key={idx} className="flex gap-2 mb-1.5">
                <Input placeholder="Label" value={item.label} onChange={(e) => {
                  const next = [...budgetItems]; next[idx] = { ...next[idx], label: e.target.value }; setBudgetItems(next);
                }} className="bg-[#111520] flex-1 h-8 text-xs" />
                <Input type="number" placeholder="$" value={item.amount} onChange={(e) => {
                  const next = [...budgetItems]; next[idx] = { ...next[idx], amount: e.target.value }; setBudgetItems(next);
                }} className="bg-[#111520] w-20 h-8 text-xs" />
                <Select value={item.cost_type} onValueChange={(v) => {
                  const next = [...budgetItems]; next[idx] = { ...next[idx], cost_type: v as any }; setBudgetItems(next);
                }}>
                  <SelectTrigger className="bg-[#111520] w-24 h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="Fixed">Fixed</SelectItem><SelectItem value="PerAsset">Per Asset</SelectItem></SelectContent>
                </Select>
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => setBudgetItems(budgetItems.filter((_, i) => i !== idx))}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))}
            {budgetItems.length > 0 && <p className="text-xs text-muted-foreground">Total: ${budgetTotal.toFixed(2)}</p>}
          </div>

          {/* Recurring line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium">Recurring Budget</span>
              <Button size="sm" variant="ghost" className="text-xs h-6" onClick={() => setRecurringItems([...recurringItems, { label: "", amount: "0", cost_type: "Fixed", frequency: "Monthly" }])}>
                <Plus className="w-3 h-3 mr-1" />Add
              </Button>
            </div>
            {recurringItems.map((item, idx) => (
              <div key={idx} className="flex gap-2 mb-1.5">
                <Input placeholder="Label" value={item.label} onChange={(e) => {
                  const next = [...recurringItems]; next[idx] = { ...next[idx], label: e.target.value }; setRecurringItems(next);
                }} className="bg-[#111520] flex-1 h-8 text-xs" />
                <Input type="number" placeholder="$" value={item.amount} onChange={(e) => {
                  const next = [...recurringItems]; next[idx] = { ...next[idx], amount: e.target.value }; setRecurringItems(next);
                }} className="bg-[#111520] w-20 h-8 text-xs" />
                <Select value={item.cost_type} onValueChange={(v) => {
                  const next = [...recurringItems]; next[idx] = { ...next[idx], cost_type: v as any }; setRecurringItems(next);
                }}>
                  <SelectTrigger className="bg-[#111520] w-24 h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="Fixed">Fixed</SelectItem><SelectItem value="PerAsset">Per Asset</SelectItem></SelectContent>
                </Select>
                <Select value={item.frequency} onValueChange={(v) => {
                  const next = [...recurringItems]; next[idx] = { ...next[idx], frequency: v as any }; setRecurringItems(next);
                }}>
                  <SelectTrigger className="bg-[#111520] w-24 h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="Monthly">Monthly</SelectItem><SelectItem value="Yearly">Yearly</SelectItem></SelectContent>
                </Select>
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => setRecurringItems(recurringItems.filter((_, i) => i !== idx))}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))}
            {recurringItems.length > 0 && <p className="text-xs text-muted-foreground">Total: ${recurringTotal.toFixed(2)}/period</p>}
          </div>

          <Button onClick={submit} className="w-full">Create Initiative</Button>
        </div>
      )}
    </div>
  );
}

// --- Shared helpers ---

function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
      {children}
    </div>
  );
}

function DateField({ date, onChange }: { date?: Date; onChange: (d: Date | undefined) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className={cn("w-full justify-start text-left font-normal bg-[#111520]", !date && "text-muted-foreground")}>
          <CalendarIcon className="mr-2 h-4 w-4" />
          {date ? format(date, "PPP") : "Pick a date"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar mode="single" selected={date} onSelect={onChange} initialFocus className="p-3 pointer-events-auto" />
      </PopoverContent>
    </Popover>
  );
}
