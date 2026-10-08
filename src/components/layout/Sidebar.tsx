import { useAuth } from "@/context/AuthContext";
import { maskApiKey } from "@/lib/scalepad-api";
import { CATEGORIES } from "@/lib/constants";
import { useNavigate, useLocation } from "react-router-dom";
import { LogOut, LayoutGrid, Clock, Shield, Settings } from "lucide-react";
import { ScalePadLogo } from "@/components/branding/ScalePadLogo";

interface SidebarProps {
  selectedCategory: string;
  onCategoryChange: (cat: string) => void;
  apps: { id: string; name: string; icon: string }[];
}

export function Sidebar({ selectedCategory, onCategoryChange, apps }: SidebarProps) {
  const { role, apiKey, logout, recentApps } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const recentAppData = recentApps
    .map((id) => apps.find((a) => a.id === id))
    .filter(Boolean) as { id: string; name: string; icon: string }[];

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-72 bg-surface border-r border-border flex flex-col z-30">
      {/* Logo */}
      <div className="px-6 py-5 border-b border-border">
        <ScalePadLogo compact />
        <p className="ml-10 text-sm text-muted-foreground mt-2">App Marketplace</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-4 space-y-1.5">
        <button
          onClick={() => navigate("/marketplace")}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-[15px] transition-colors duration-150 ${
            location.pathname === "/marketplace"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
        >
          <LayoutGrid className="w-[18px] h-[18px]" />
          Marketplace
        </button>

        {/* Recent Apps */}
        {recentAppData.length > 0 && (
          <div className="pt-3">
            <p className="px-3 text-[11px] uppercase tracking-[0.12em] text-muted-foreground mb-2 flex items-center gap-2">
              <Clock className="w-4 h-4" /> Recent
            </p>
            {recentAppData.map((app) => (
              <button
                key={app.id}
                onClick={() => navigate(`/marketplace/${app.id}`)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[15px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors duration-150"
              >
                <span>{app.icon}</span>
                <span className="truncate">{app.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* Admin link */}
        {role === "admin" && (
          <button
            onClick={() => navigate("/admin")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors duration-150 ${
              location.pathname === "/admin"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
          >
            <Shield className="w-4 h-4" />
            Admin Panel
          </button>
        )}

        <button
          onClick={() => navigate("/settings")}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors duration-150 ${
            location.pathname === "/settings"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
        >
          <Settings className="w-4 h-4" />
          Settings
        </button>

        {/* Categories */}
        <div className="pt-4">
          <p className="px-3 text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
            Categories
          </p>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => {
                onCategoryChange(cat);
                if (location.pathname !== "/marketplace") navigate("/marketplace");
              }}
              className={`w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors duration-150 ${
                selectedCategory === cat
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-border space-y-2">
        <div className="flex items-center gap-2 px-2">
          <span className="w-2 h-2 rounded-full bg-success shrink-0" />
          <span className="text-xs text-muted-foreground truncate">{maskApiKey(apiKey)}</span>
        </div>
        <button
          onClick={() => {
            logout();
            navigate("/login");
          }}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm text-destructive hover:bg-destructive/10 transition-colors duration-150"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
