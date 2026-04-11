const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-scalepad-api-key",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { endpoint, method, body, url, headers: customHeaders } = await req.json();

    const requestMethod = method || "GET";
    let targetUrl = "";
    let requestHeaders: Record<string, string> = {
      Accept: "application/json",
    };
    let requestBody: BodyInit | undefined = undefined;

    if (typeof url === "string" && url.trim()) {
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== "https:") {
          throw new Error("Only https URLs are allowed");
        }
        targetUrl = parsedUrl.toString();
      } catch {
        return new Response(
          JSON.stringify({ error: "Invalid request url" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (customHeaders && typeof customHeaders === "object") {
        for (const [key, value] of Object.entries(customHeaders)) {
          if (typeof value === "string" && value.trim()) {
            requestHeaders[key] = value;
          }
        }
      }
    } else {
      const scalepadApiKey = (req.headers.get("x-scalepad-api-key") || "").trim();
      if (!scalepadApiKey) {
        return new Response(
          JSON.stringify({ error: "Missing x-scalepad-api-key header" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!endpoint || !endpoint.startsWith("/") || endpoint.includes("..")) {
        return new Response(
          JSON.stringify({ error: "Invalid endpoint path" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      targetUrl = `https://api.scalepad.com${endpoint}`;
      requestHeaders = {
        ...requestHeaders,
        "x-api-key": scalepadApiKey,
        "Content-Type": "application/json",
      };
    }

    const reqContentType = requestHeaders["Content-Type"] || requestHeaders["content-type"] || "";
    if (body !== undefined && body !== null) {
      if (typeof body === "string") {
        requestBody = body;
      } else if (reqContentType.includes("application/x-www-form-urlencoded")) {
        requestBody = new URLSearchParams(
          Object.entries(body).reduce<Record<string, string>>((acc, [key, value]) => {
            if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
              acc[key] = String(value);
            }
            return acc;
          }, {})
        ).toString();
      } else {
        requestHeaders["Content-Type"] = "application/json";
        requestBody = JSON.stringify(body);
      }
    }

    const response = await fetch(targetUrl, {
      method: requestMethod,
      headers: requestHeaders,
      body: requestBody,
    });

    // Handle 204 No Content (DELETE, some PUTs)
    let data: Record<string, unknown> = {};
    const respContentType = response.headers.get("content-type") || "";
    if (response.status !== 204 && respContentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch {
        // empty body is fine
      }
    }

    // Always return 200 to avoid supabase.functions.invoke treating non-2xx as errors
    // Include upstream status so the frontend can handle errors from the body
    return new Response(JSON.stringify({ upstream_status: response.status, ...data }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Proxy error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
