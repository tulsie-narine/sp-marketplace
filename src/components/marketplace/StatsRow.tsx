import { useAuth } from "@/context/AuthContext";
import { MarketplaceApp } from "@/lib/constants";

interface StatsRowProps {
  apps: MarketplaceApp[];
}

export function StatsRow({ apps }: StatsRowProps) {
  const { role } = useAuth();
  if (role !== "admin") return null;

  const active = apps.filter((a) => a.status === "active").length;
  const beta = apps.filter((a) => a.status === "beta").length;
  const categories = new Set(apps.map((a) => a.category)).size;

  const stats = [
    { label: "Total Apps", value: apps.length, color: "text-primary" },
    { label: "Active", value: active, color: "text-success" },
    { label: "Beta", value: beta, color: "text-warning" },
    { label: "Categories", value: categories, color: "text-foreground" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {stats.map((s) => (
        <div key={s.label} className="surface-panel p-5">
          <p className="eyebrow mb-2">{s.label}</p>
          <p className={`text-3xl font-heading font-bold ${s.color}`}>{s.value}</p>
        </div>
      ))}
    </div>
  );
}
