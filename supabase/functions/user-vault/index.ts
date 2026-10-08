// Key-identity vault: callers are identified by SHA-256 of their ScalePad API key.
// Only someone presenting the same key can read/modify the data scoped to that hash.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-scalepad-api-key",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.scalepad.com/core/v1/clients?page_size=1", {
      headers: { "x-api-key": apiKey, Accept: "application/json" },
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");
const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 500) : []);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const apiKey = (req.headers.get("x-scalepad-api-key") || "").trim();
  if (!apiKey || apiKey.length > 1000) return json({ error: "Missing x-scalepad-api-key header" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const action = str(body.action, 50);
  const ownerHash = await sha256(apiKey);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const storeKey = async () => {
    if (!(await verifyKey(apiKey))) throw new Error("ScalePad rejected this API key.");
    const { error } = await db
      .from("saved_api_keys")
      .upsert({ key_hash: ownerHash, api_key: apiKey }, { onConflict: "key_hash" });
    if (error) throw error;
  };

  try {
    switch (action) {
      // ---- Key vault ----
      case "key.status": {
        const { data } = await db.from("saved_api_keys").select("created_at, updated_at").eq("key_hash", ownerHash).maybeSingle();
        return json({ saved: !!data, saved_at: data?.updated_at ?? null });
      }
      case "key.save": {
        await storeKey();
        return json({ saved: true });
      }
      case "key.forget": {
        await db.from("saved_api_keys").delete().eq("key_hash", ownerHash);
        await db.from("scheduled_tasks").update({ schedule_enabled: false }).eq("owner_hash", ownerHash);
        await db.from("lcm_data_reset_configs").update({ schedule_enabled: false }).eq("owner_hash", ownerHash);
        return json({ saved: false });
      }

      // ---- Generic scheduled tasks (for new mini-apps) ----
      case "tasks.list": {
        const { data, error } = await db.from("scheduled_tasks").select("*")
          .eq("owner_hash", ownerHash).eq("app_id", str(body.appId, 100)).order("updated_at", { ascending: false });
        if (error) throw error;
        return json({ data });
      }
      case "tasks.save": {
        const appId = str(body.appId, 100);
        if (!appId) return json({ error: "appId required" }, 400);
        const row = {
          owner_hash: ownerHash,
          app_id: appId,
          name: str(body.name, 200) || "Default",
          config: (body.config && typeof body.config === "object") ? body.config : {},
          schedule_enabled: body.scheduleEnabled === true,
        };
        if (row.schedule_enabled) await storeKey();
        const q = body.id
          ? db.from("scheduled_tasks").update(row).eq("id", str(body.id, 64)).eq("owner_hash", ownerHash)
          : db.from("scheduled_tasks").insert(row);
        const { data, error } = await q.select().single();
        if (error) throw error;
        return json({ data });
      }
      case "tasks.delete": {
        const { error } = await db.from("scheduled_tasks").delete().eq("id", str(body.id, 64)).eq("owner_hash", ownerHash);
        if (error) throw error;
        return json({ ok: true });
      }
      case "tasks.setSchedule": {
        if (body.enabled === true) await storeKey();
        const { data, error } = await db.from("scheduled_tasks").update({ schedule_enabled: body.enabled === true })
          .eq("id", str(body.id, 64)).eq("owner_hash", ownerHash).select().single();
        if (error) throw error;
        return json({ data });
      }

      // ---- LCM Data Reset configs ----
      case "lcm.list": {
        const { data, error } = await db.from("lcm_data_reset_configs").select("*")
          .eq("owner_hash", ownerHash).order("updated_at", { ascending: false });
        if (error) throw error;
        return json({ data: (data || []).map(({ destination_api_key: _k, ...r }) => r) });
      }
      case "lcm.save": {
        const c = (body.config || {}) as Record<string, unknown>;
        const row = {
          owner_hash: ownerHash,
          name: str(c.name, 200) || "Default",
          destination_api_key: apiKey,
          source_client_id: str(c.sourceClientId, 100),
          source_client_name: str(c.sourceClientName, 300),
          destination_client_ids: strArr(c.destinationClientIds),
          destination_client_names: strArr(c.destinationClientNames),
          selected_objects: (c.selectedObjects && typeof c.selectedObjects === "object") ? c.selectedObjects : {},
          schedule_enabled: c.scheduleEnabled === true,
        };
        if (!row.source_client_id) return json({ error: "Source client required" }, 400);
        await storeKey();
        const q = body.id
          ? db.from("lcm_data_reset_configs").update(row).eq("id", str(body.id, 64)).eq("owner_hash", ownerHash)
          : db.from("lcm_data_reset_configs").insert(row);
        const { data, error } = await q.select().single();
        if (error) throw error;
        const { destination_api_key: _k, ...rest } = data;
        return json({ data: rest });
      }
      case "lcm.delete": {
        const id = str(body.id, 64);
        await db.from("lcm_data_reset_runs").delete().eq("config_id", id).eq("owner_hash", ownerHash);
        const { error } = await db.from("lcm_data_reset_configs").delete().eq("id", id).eq("owner_hash", ownerHash);
        if (error) throw error;
        return json({ ok: true });
      }
      case "lcm.setSchedule": {
        if (body.enabled === true) await storeKey();
        const { data, error } = await db.from("lcm_data_reset_configs").update({ schedule_enabled: body.enabled === true })
          .eq("id", str(body.id, 64)).eq("owner_hash", ownerHash).select().single();
        if (error) throw error;
        const { destination_api_key: _k, ...rest } = data;
        return json({ data: rest });
      }
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
