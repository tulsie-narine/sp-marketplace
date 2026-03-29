import React, { createContext, useContext, useState, useCallback } from "react";
import { MarketplaceApp } from "@/lib/constants";
import { SEED_APPS } from "@/lib/mock-data";
import { toast } from "sonner";

interface AppStoreState {
  apps: MarketplaceApp[];
  addApp: (app: Omit<MarketplaceApp, "id" | "created_at">) => void;
  updateApp: (id: string, data: Partial<MarketplaceApp>) => void;
  deleteApp: (id: string) => void;
  toggleStatus: (id: string) => void;
  resetToDefaults: () => void;
}

const AppStoreContext = createContext<AppStoreState | null>(null);

function mergeSeedApps(storedApps: MarketplaceApp[]) {
  const existingIds = new Set(storedApps.map((app) => app.id));
  const missingSeedApps = SEED_APPS.filter((app) => !existingIds.has(app.id));
  return [...storedApps, ...missingSeedApps];
}

export function AppStoreProvider({ children }: { children: React.ReactNode }) {
  const [apps, setApps] = useState<MarketplaceApp[]>(() => {
    try {
      const stored = localStorage.getItem("sp_apps");
      if (!stored) return SEED_APPS;

      const parsed = JSON.parse(stored) as MarketplaceApp[];
      return mergeSeedApps(parsed);
    } catch {
      return SEED_APPS;
    }
  });

  const persist = (next: MarketplaceApp[]) => {
    setApps(next);
    localStorage.setItem("sp_apps", JSON.stringify(next));
  };

  const addApp = useCallback((data: Omit<MarketplaceApp, "id" | "created_at">) => {
    const app: MarketplaceApp = {
      ...data,
      id: `app-${Date.now()}`,
      created_at: new Date().toISOString(),
    };
    persist([...apps, app]);
    toast.success(`"${app.name}" added to marketplace`);
  }, [apps]);

  const updateApp = useCallback((id: string, data: Partial<MarketplaceApp>) => {
    persist(apps.map((a) => (a.id === id ? { ...a, ...data } : a)));
    toast.success("App updated");
  }, [apps]);

  const deleteApp = useCallback((id: string) => {
    const name = apps.find((a) => a.id === id)?.name;
    persist(apps.filter((a) => a.id !== id));
    toast.success(`"${name}" deleted`);
  }, [apps]);

  const toggleStatus = useCallback((id: string) => {
    persist(
      apps.map((a) =>
        a.id === id ? { ...a, status: a.status === "inactive" ? "active" : "inactive" } : a
      )
    );
  }, [apps]);

  const resetToDefaults = useCallback(() => {
    persist(SEED_APPS);
    toast.success("Registry reset to defaults");
  }, []);

  return (
    <AppStoreContext.Provider value={{ apps, addApp, updateApp, deleteApp, toggleStatus, resetToDefaults }}>
      {children}
    </AppStoreContext.Provider>
  );
}

export function useAppStore() {
  const ctx = useContext(AppStoreContext);
  if (!ctx) throw new Error("useAppStore must be used within AppStoreProvider");
  return ctx;
}
