/**
 * ControlMap Assessment Importer API helpers.
 * All calls go through the scalepad-proxy edge function with the signed-in API key.
 * The parsing, matching and planning engine lives in src/lib/controlmap-importer.
 */

import { supabase } from "@/integrations/supabase/client";
import { createControlMapClient } from "@/lib/controlmap-importer/controlmap";
import type { Transport } from "@/lib/controlmap-importer/http";

const CM_PREFIX = "/controlmap/v1";

/** Sends one request through scalepad-proxy and hands back the upstream status and body. */
function proxyTransport(apiKey: string): Transport {
  return async (method, path, body) => {
    const { data, error } = await supabase.functions.invoke("scalepad-proxy", {
      body: { endpoint: `${CM_PREFIX}${path}`, method, body },
      headers: { "x-scalepad-api-key": apiKey },
    });
    if (error) throw new Error(error.message || "Couldn't reach the ScalePad proxy");
    if (!data?.upstream_status) throw new Error(data?.error || "The ScalePad proxy returned no response");
    const { upstream_status, ...rest } = data;
    return { status: upstream_status, body: "response_text" in rest ? rest.response_text : rest };
  };
}

/** A ControlMap client for the signed-in API key. */
export function controlMapClientFor(apiKey: string) {
  return createControlMapClient({ transport: proxyTransport(apiKey) });
}
