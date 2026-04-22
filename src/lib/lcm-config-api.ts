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
    destination_client_ids: input.destinationClientIds,
    destination_client_names: input.destinationClientNames,
    selected_objects: input.selectedObjects,
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

export async function listConfigs(): Promise<LcmDataResetConfig[]> {
  const { data, error } = await supabase
    .from("lcm_data_reset_configs")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(fromRow);
}

export async function saveConfig(input: SaveConfigInput): Promise<LcmDataResetConfig> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new Error("You must be signed in to save configurations.");
  }
  const userId = userData.user.id;
  const row = toRow(input, userId);

  if (input.id) {
    const { data, error } = await supabase
      .from("lcm_data_reset_configs")
      .update(row)
      .eq("id", input.id)
      .select()
      .single();
    if (error) throw error;
    return fromRow(data);
  }

  const { data, error } = await supabase
    .from("lcm_data_reset_configs")
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return fromRow(data);
}

export async function deleteConfig(id: string): Promise<void> {
  const { error } = await supabase
    .from("lcm_data_reset_configs")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

export async function setScheduleEnabled(
  id: string,
  enabled: boolean
): Promise<LcmDataResetConfig> {
  const { data, error } = await supabase
    .from("lcm_data_reset_configs")
    .update({ schedule_enabled: enabled })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return fromRow(data);
}
