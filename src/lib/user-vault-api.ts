import { supabase } from "@/integrations/supabase/client";

/**
 * Calls the `user-vault` edge function. The caller is identified by their
 * session ScalePad API key (hashed server-side) — only the same key can
 * view or change the saved key and its schedules.
 */
export async function callVault<T = any>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const apiKey = sessionStorage.getItem("sp_api_key") || "";
  if (!apiKey || apiKey === "admin-key") {
    throw new Error("Sign in with your ScalePad API key to use saved keys and schedules.");
  }
  const { data, error } = await supabase.functions.invoke("user-vault", {
    body: { action, ...payload },
    headers: { "x-scalepad-api-key": apiKey },
  });
  if (data?.error) throw new Error(data.error);
  if (error) {
    let msg = error.message;
    try {
      const ctx = await (error as any).context?.json?.();
      if (ctx?.error) msg = ctx.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return data as T;
}

export const getKeyStatus = () => callVault<{ saved: boolean; saved_at: string | null }>("key.status");
export const saveKey = () => callVault<{ saved: boolean }>("key.save");
export const forgetKey = () => callVault<{ saved: boolean }>("key.forget");

export interface ScheduledTask<C = Record<string, unknown>> {
  id: string;
  app_id: string;
  name: string;
  config: C;
  schedule_enabled: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_summary: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** Generic per-key scheduled tasks for mini-apps. */
export const listTasks = async (appId: string) =>
  (await callVault<{ data: ScheduledTask[] }>("tasks.list", { appId })).data;
export const saveTask = async (input: { id?: string; appId: string; name: string; config: Record<string, unknown>; scheduleEnabled: boolean }) =>
  (await callVault<{ data: ScheduledTask }>("tasks.save", input)).data;
export const deleteTask = (id: string) => callVault("tasks.delete", { id });
export const setTaskSchedule = async (id: string, enabled: boolean) =>
  (await callVault<{ data: ScheduledTask }>("tasks.setSchedule", { id, enabled })).data;
