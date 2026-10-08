import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { forgetKey, getKeyStatus, saveKey } from "@/lib/user-vault-api";

export function SavedKeyCard() {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getKeyStatus().then((s) => setSaved(s.saved)).catch(() => setSaved(false));
  }, []);

  const run = async (fn: () => Promise<{ saved: boolean }>, msg: string) => {
    setBusy(true);
    try {
      const r = await fn();
      setSaved(r.saved);
      toast.success(msg);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg p-5 space-y-3">
      <h3 className="font-heading font-bold text-sm">Scheduled Tasks Access</h3>
      <p className="text-xs text-muted-foreground">
        Save your key so apps can run nightly tasks for you. Only someone signing in with this same key can view or
        change its schedules. Forgetting the key pauses all of its schedules.
      </p>
      <div className="flex items-center gap-2 text-sm">
        <span className={`w-2 h-2 rounded-full ${saved ? "bg-success" : "bg-muted-foreground"}`} />
        {saved === null ? "Checking…" : saved ? "Key saved for scheduled tasks" : "Key not saved"}
      </div>
      <button
        disabled={busy || saved === null}
        onClick={() => (saved ? run(forgetKey, "Saved key removed") : run(saveKey, "Key saved"))}
        className={`h-9 px-4 rounded-md text-sm flex items-center gap-1.5 transition-colors duration-150 disabled:opacity-50 ${
          saved
            ? "bg-destructive/10 border border-destructive/20 text-destructive hover:bg-destructive/20"
            : "bg-primary text-primary-foreground hover:bg-primary/90"
        }`}
      >
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        {saved ? "Forget Saved Key" : "Save Key for Scheduled Tasks"}
      </button>
    </div>
  );
}
