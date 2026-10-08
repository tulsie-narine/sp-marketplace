import { Search, Plus } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

interface TopbarProps {
  title: string;
  appCount?: number;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onAddApp?: () => void;
}

export function Topbar({ title, appCount, searchQuery, onSearchChange, onAddApp }: TopbarProps) {
  const { role } = useAuth();

  return (
    <header className="h-[76px] border-b border-border bg-surface flex items-center justify-between px-8 shrink-0">
      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-heading font-bold">{title}</h2>
        {appCount !== undefined && (
          <span className="text-sm bg-muted px-3 py-1 rounded-full text-muted-foreground">
            {appCount} apps
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search apps…"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-80 h-11 pl-10 pr-3 bg-surface-raised border border-border rounded-lg text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all duration-150"
          />
        </div>
        {role === "admin" && onAddApp && (
          <button
            onClick={onAddApp}
            className="h-11 px-5 bg-primary hover:bg-primary/90 text-primary-foreground text-[15px] font-semibold rounded-lg flex items-center gap-2 transition-colors duration-150"
          >
            <Plus className="w-4 h-4" />
            Add App
          </button>
        )}
      </div>
    </header>
  );
}
