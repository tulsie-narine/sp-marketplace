import { MarketplaceApp } from "@/lib/constants";
import { useNavigate } from "react-router-dom";
import { ScalePadMark } from "@/components/branding/ScalePadMark";

interface AppCardProps {
  app: MarketplaceApp;
}

const statusColors: Record<string, string> = {
  active: "bg-success/15 text-success",
  beta: "bg-warning/15 text-warning",
  inactive: "bg-muted text-muted-foreground",
};

export function AppCard({ app }: AppCardProps) {
  const navigate = useNavigate();

  return (
    <button
      onClick={() => navigate(`/marketplace/${app.id}`)}
      className="group text-left w-full surface-panel p-6 hover:border-primary/50 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-primary/10 transition-all duration-200 animate-fade-in"
    >
      <div className="flex items-start justify-between mb-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          {app.id === "app-012" ? <ScalePadMark className="h-8 w-8" /> : <span className="text-3xl">{app.icon}</span>}
        </span>
        <span className={`text-xs px-2.5 py-1 rounded-full font-semibold uppercase tracking-wide ${statusColors[app.status]}`}>
          {app.status}
        </span>
      </div>
      <h3 className="text-lg font-heading font-bold text-foreground mb-2 group-hover:text-primary transition-colors duration-150">
        {app.name}
      </h3>
      <p className="text-[15px] leading-6 text-muted-foreground line-clamp-3 mb-5">{app.description}</p>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{app.category}</span>
        <span>v{app.version}</span>
      </div>
    </button>
  );
}
