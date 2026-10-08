import { callVault } from "@/lib/user-vault-api";
import { supabase } from "@/integrations/supabase/client";
import type { SelectedObjects } from "@/lib/tenant-migration-api";

export interface LcmDataResetConfig {
  id: string;
  user_id: string;
  name: string;
  destination_api_key: string;
  source_client_id: string;
  source_client_name: string;
  destination_client_ids: string[];
  destination_client_names: string[];
  selected_objects: SelectedObjects;
  schedule_enabled: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_summary: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface SaveConfigInput {
  id?: string;
  name: string;
  destinationApiKey: string;
  sourceClientId: string;
  sourceClientName: string;
  destinationClientIds: string[];
  destinationClientNames: string[];
  selectedObjects: SelectedObjects;
  scheduleEnabled: boolean;
}

function toRow(input: SaveConfigInput, userId: string) {
  return {
    user_id: userId,
    name: input.name,
    destination_api_key: input.destinationApiKey,
    source_client_id: input.sourceClientId,
    source_client_name: input.sourceClientName,
    destination_client_ids: input.destinationClientIds as unknown as never,
    destination_client_names: input.destinationClientNames as unknown as never,
    selected_objects: input.selectedObjects as unknown as never,
    schedule_enabled: input.scheduleEnabled,
  };
}

function fromRow(row: any): LcmDataResetConfig {
  return {
    ...row,
    destination_client_ids: Array.isArray(row.destination_client_ids)
      ? row.destination_client_ids
      : [],
    destination_client_names: Array.isArray(row.destination_client_names)
      ? row.destination_client_names
      : [],
    selected_objects: row.selected_objects || {},
  };
}

// Configs are owned by the session API key (via the user-vault function).
export async function listConfigs(): Promise<LcmDataResetConfig[]> {
  const { data } = await callVault<{ data: any[] }>("lcm.list");
  return (data || []).map(fromRow);
}

export async function saveConfig(input: SaveConfigInput): Promise<LcmDataResetConfig> {
  const { id, destinationApiKey: _ignored, ...config } = input;
  const { data } = await callVault<{ data: any }>("lcm.save", { id, config });
  return fromRow(data);
}

export async function deleteConfig(id: string): Promise<void> {
  await callVault("lcm.delete", { id });
}

export async function setScheduleEnabled(
  id: string,
  enabled: boolean
): Promise<LcmDataResetConfig> {
  const { data } = await callVault<{ data: any }>("lcm.setSchedule", { id, enabled });
  return fromRow(data);
}
