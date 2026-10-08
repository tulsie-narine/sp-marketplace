import { useState } from "react";
import { useAppStore } from "@/context/AppStoreContext";
import { MarketplaceApp } from "@/lib/constants";

import { Sidebar } from "@/components/layout/Sidebar";
import { AppFormModal } from "@/components/admin/AppFormModal";
import { DeleteConfirmModal } from "@/components/admin/DeleteConfirmModal";
import { Pencil, Trash2, Plus } from "lucide-react";
import { ScalePadMark } from "@/components/branding/ScalePadMark";

const statusColors: Record<string, string> = {
  active: "bg-success/15 text-success",
  beta: "bg-warning/15 text-warning",
  inactive: "bg-muted text-muted-foreground",
};

export default function Admin() {
  const { apps, addApp, updateApp, deleteApp, toggleStatus } = useAppStore();
  const [editApp, setEditApp] = useState<MarketplaceApp | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MarketplaceApp | null>(null);
  const [category, setCategory] = useState("All");

  return (
    <div className="min-h-screen flex">
      <Sidebar selectedCategory={category} onCategoryChange={setCategory} apps={apps} />

      <div className="ml-60 flex-1 flex flex-col min-h-screen">
        
        <header className="h-16 border-b border-border bg-surface flex items-center justify-between px-6 shrink-0">
          <h2 className="text-lg font-heading font-bold">Admin Panel</h2>
          <button
            onClick={() => setShowAdd(true)}
            className="h-9 px-4 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-md flex items-center gap-1.5 transition-colors duration-150"
          >
            <Plus className="w-4 h-4" />
            Add App
          </button>
        </header>

        <main className="flex-1 p-6 overflow-y-auto">
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="p-3">Icon</th>
                  <th className="p-3">Name</th>
                  <th className="p-3">Category</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Version</th>
                  <th className="p-3">Author</th>
                  <th className="p-3">Endpoint</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => (
                  <tr key={app.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors duration-150">
                    <td className="p-3 text-primary">
                      {app.id === "app-012" ? <ScalePadMark className="h-7 w-7" /> : <span className="text-xl">{app.icon}</span>}
                    </td>
                    <td className="p-3 font-medium text-foreground">{app.name}</td>
                    <td className="p-3 text-muted-foreground">{app.category}</td>
                    <td className="p-3">
                      <button
                        onClick={() => toggleStatus(app.id)}
                        className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wide cursor-pointer ${statusColors[app.status]}`}
                        title="Click to toggle active/inactive"
                      >
                        {app.status}
                      </button>
                    </td>
                    <td className="p-3 text-muted-foreground">v{app.version}</td>
                    <td className="p-3 text-muted-foreground">{app.author}</td>
                    <td className="p-3 text-muted-foreground font-mono text-xs">{app.api_endpoint}</td>
                    <td className="p-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => setEditApp(app)}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors duration-150"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setDeleteTarget(app)}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors duration-150"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </main>
      </div>

      <AppFormModal
        open={showAdd || !!editApp}
        onClose={() => { setShowAdd(false); setEditApp(null); }}
        initial={editApp}
        onSave={(data) => {
          if (editApp) {
            updateApp(editApp.id, data);
          } else {
            addApp(data);
          }
          setEditApp(null);
        }}
      />

      <DeleteConfirmModal
        open={!!deleteTarget}
        appName={deleteTarget?.name || ""}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteApp(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
