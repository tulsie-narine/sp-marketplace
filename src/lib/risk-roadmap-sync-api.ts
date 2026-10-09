import { supabase } from "@/integrations/supabase/client";
import { deleteTask, listTasks, saveTask, setTaskSchedule, type ScheduledTask } from "@/lib/user-vault-api";

export const RISK_ROADMAP_APP_ID = "risk-roadmap";

export type RoadmapSyncConfig = {
  clientId: string;
  clientName: string;
  sourceType: "action_items" | "risks";
  destination: "initiatives" | "action_items";
  onRemoved: "decline" | "ignore";
  skipStatuses: string[];
  horizonMonths: 3 | 6 | 12;
  syncAll: boolean;
  selectedSourceIds: string[];
};

export const listRoadmapSyncTasks = () => listTasks(RISK_ROADMAP_APP_ID) as Promise<ScheduledTask<RoadmapSyncConfig>[]>;

export const saveRoadmapSyncTask = (input: {
  id?: string;
  name: string;
  config: RoadmapSyncConfig;
  scheduleEnabled: boolean;
}) => saveTask({ ...input, appId: RISK_ROADMAP_APP_ID });

export const setRoadmapSyncSchedule = (id: string, enabled: boolean) => setTaskSchedule(id, enabled);
export const deleteRoadmapSyncTask = (id: string) => deleteTask(id);

export async function runRoadmapSync(taskId: string, mode: "dry-run" | "live") {
  const apiKey = sessionStorage.getItem("sp_api_key") || "";
  if (!apiKey || apiKey === "admin-key") throw new Error("Sign in with a ScalePad API key to run a roadmap sync.");
  const { data, error } = await supabase.functions.invoke("risk-roadmap-sync", {
    body: { taskId, mode },
    headers: { "x-scalepad-api-key": apiKey },
  });
  if (error) throw new Error(error.message || "Sync request failed");
  if (data?.error) throw new Error(data.error);
  return data as { task_id: string; status: string; summary: Record<string, number> };
}
