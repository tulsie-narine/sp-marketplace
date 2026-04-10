import { useParams, useNavigate } from "react-router-dom";
import { useAppStore } from "@/context/AppStoreContext";
import { useAuth } from "@/context/AuthContext";
import { useEffect } from "react";
import { MiniAppWorkspace } from "@/components/workspace/MiniAppWorkspace";
import { OpportunitiesWorkspace } from "@/components/workspace/OpportunitiesWorkspace";
import { InitiativeManagerWorkspace } from "@/components/workspace/InitiativeManagerWorkspace";
import { GoalManagerWorkspace } from "@/components/workspace/GoalManagerWorkspace";
import { TenantMigrationWorkspace } from "@/components/workspace/TenantMigrationWorkspace";
import { LcmDataResetWorkspace } from "@/components/workspace/LcmDataResetWorkspace";
import { ClientCleanUpWorkspace } from "@/components/workspace/ClientCleanUpWorkspace";
import { RiskRoadmapWorkspace } from "@/components/workspace/RiskRoadmapWorkspace";
import { AppRatingsComments } from "@/components/marketplace/AppRatingsComments";

import { ArrowLeft } from "lucide-react";

const statusColors: Record<string, string> = {
  active: "bg-success/15 text-success",
  beta: "bg-warning/15 text-warning",
  inactive: "bg-muted text-muted-foreground",
};

export default function AppDetail() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const { apps } = useAppStore();
  const { addRecentApp } = useAuth();

  const app = apps.find((a) => a.id === appId);

  useEffect(() => {
    if (app) addRecentApp(app.id);
  }, [app?.id]);

  if (!app) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-lg text-muted-foreground">App not found</p>
          <button onClick={() => navigate("/marketplace")} className="mt-3 text-primary text-sm hover:underline">
            Back to Marketplace
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Back */}
        <button
          onClick={() => navigate("/marketplace")}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors duration-150"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Marketplace
        </button>

        {/* Header */}
        <div className="bg-card border border-border rounded-lg p-6 flex items-start gap-5 animate-fade-in">
          <span className="text-5xl">{app.icon}</span>
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-heading font-extrabold">{app.name}</h1>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wide ${statusColors[app.status]}`}>
                {app.status}
              </span>
            </div>
            <p className="text-sm text-muted-foreground mb-2">
              v{app.version} · {app.author} · {app.category}
            </p>
            <p className="text-sm text-foreground">{app.description}</p>
          </div>
        </div>

        {/* How it works */}
        <div className="bg-card border border-border rounded-lg p-5">
          <h3 className="font-heading font-bold text-sm text-foreground mb-2">How it works</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">{app.how_it_works}</p>
          <p className="text-xs text-muted-foreground mt-3 font-mono">
            Endpoint: {app.api_endpoint}
          </p>
        </div>

        {/* Workspace — route to appropriate workspace */}
        {(app.input_schema as any)?.appType === "initiative-manager" ? (
          <InitiativeManagerWorkspace />
        ) : (app.input_schema as any)?.appType === "goal-manager" ? (
          <GoalManagerWorkspace />
        ) : (app.input_schema as any)?.appType === "tenant-migration" ? (
          <TenantMigrationWorkspace />
        ) : (app.input_schema as any)?.appType === "lcm-data-reset" ? (
          <LcmDataResetWorkspace />
        ) : (app.input_schema as any)?.appType === "client-cleanup" ? (
          <ClientCleanUpWorkspace />
        ) : (app.input_schema as any)?.appType === "risk-roadmap" ? (
          <RiskRoadmapWorkspace />
        ) : (app.input_schema as any)?.realApi ? (
          <OpportunitiesWorkspace app={app} />
        ) : (
          <MiniAppWorkspace app={app} />
        )}

        {/* Ratings & Comments */}
        <AppRatingsComments appId={app.id} />
      </div>
    </div>
  );
}
