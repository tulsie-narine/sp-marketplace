import { useAuth } from "@/context/AuthContext";
import { useAppStore } from "@/context/AppStoreContext";
import { maskApiKey } from "@/lib/scalepad-api";
import { useNavigate } from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";

import { useState } from "react";
import { toast } from "sonner";
import { Download, Upload, RotateCcw } from "lucide-react";

export default function SettingsPage() {
  const { apiKey, role, logout } = useAuth();
  const { apps, resetToDefaults } = useAppStore();
  const navigate = useNavigate();
  const [category, setCategory] = useState("All");

  const handleChangeKey = () => {
    logout();
    navigate("/login");
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(apps, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "scalepad-app-registry.json";
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Registry exported");
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result as string);
          if (Array.isArray(data)) {
            localStorage.setItem("sp_apps", JSON.stringify(data));
            toast.success("Registry imported — reload to see changes");
            window.location.reload();
          }
        } catch {
          toast.error("Invalid JSON file");
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  return (
    <div className="min-h-screen flex">
      <Sidebar selectedCategory={category} onCategoryChange={setCategory} apps={apps} />

      <div className="ml-60 flex-1 flex flex-col min-h-screen">
        
        <header className="h-16 border-b border-border bg-surface flex items-center px-6 shrink-0">
          <h2 className="text-lg font-heading font-bold">Settings</h2>
        </header>

        <main className="flex-1 p-6 space-y-6 overflow-y-auto max-w-2xl">
          {/* API Key */}
          <div className="bg-card border border-border rounded-lg p-5 space-y-3">
            <h3 className="font-heading font-bold text-sm">API Key</h3>
            <div className="flex items-center gap-3">
              <span className="w-2 h-2 rounded-full bg-success shrink-0" />
              <code className="text-sm text-muted-foreground font-mono">{maskApiKey(apiKey)}</code>
            </div>
            <button
              onClick={handleChangeKey}
              className="h-9 px-4 bg-surface-raised border border-border rounded-md text-sm text-foreground hover:bg-muted/50 transition-colors duration-150"
            >
              Change API Key
            </button>
          </div>

          {role !== "admin" && <SavedKeyCard />}

          {/* Admin section */}
          {role === "admin" && (
            <div className="bg-card border border-border rounded-lg p-5 space-y-4">
              <h3 className="font-heading font-bold text-sm">Admin Tools</h3>
              <div className="flex flex-wrap gap-3">
                <button onClick={handleExport}
                  className="h-9 px-4 bg-surface-raised border border-border rounded-md text-sm text-foreground hover:bg-muted/50 flex items-center gap-1.5 transition-colors duration-150">
                  <Download className="w-4 h-4" /> Export Registry
                </button>
                <button onClick={handleImport}
                  className="h-9 px-4 bg-surface-raised border border-border rounded-md text-sm text-foreground hover:bg-muted/50 flex items-center gap-1.5 transition-colors duration-150">
                  <Upload className="w-4 h-4" /> Import Registry
                </button>
                <button onClick={() => {
                  if (confirm("Reset all apps to defaults?")) resetToDefaults();
                }}
                  className="h-9 px-4 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive hover:bg-destructive/20 flex items-center gap-1.5 transition-colors duration-150">
                  <RotateCcw className="w-4 h-4" /> Reset to Defaults
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Note: admin password change requires Supabase Auth (not available in POC).
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
