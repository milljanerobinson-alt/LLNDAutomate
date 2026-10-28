import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function verifyAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.replace("Bearer ", "");
  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );
  const { data: { user }, error } = await anonClient.auth.getUser(token);
  if (error || !user) return null;
  const svc = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: profile } = await svc.from("profiles").select("role").eq("id", user.id).maybeSingle();
  // Issue #45: operator status (grant + MFA) is enforced by requirePlatformOperator() in the request handler; the legacy profiles.role check is retired.
  if (!profile) return null;
  return svc;
}

const VALID_PROVIDERS = ["openai", "gemini", "anthropic"] as const;
type Provider = typeof VALID_PROVIDERS[number];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Issue #45: platform operators with MFA only (no service-role bypass for platform credentials).
  {
    const operatorCheck = await requirePlatformOperator(req.headers.get("Authorization"), { allowServiceRole: false });
    if (!operatorCheck.ok) return operatorDeniedResponse(operatorCheck, corsHeaders);
  }

  try {
    const svc = await verifyAdmin(req);
    if (!svc) return err("Unauthorized", 401);

    const body = await req.json();
    const { provider, api_key, model, base_url, is_default } = body as {
      provider: Provider;
      api_key?: string;
      model?: string;
      base_url?: string;
      is_default?: boolean;
    };

    if (!VALID_PROVIDERS.includes(provider)) {
      return err(`Invalid provider. Must be one of: ${VALID_PROVIDERS.join(", ")}`);
    }

    const now = new Date().toISOString();
    const configUpdates: Record<string, unknown> = { updated_at: now };

    // Save API key to settings table
    if (api_key !== undefined) {
      const keySettingName = `${provider}_api_key`;
      const { error: keyErr } = await svc.from("settings").upsert(
        { key: keySettingName, value: api_key, updated_at: now },
        { onConflict: "key" },
      );
      if (keyErr) throw new Error(`Failed to save API key: ${keyErr.message}`);
      configUpdates.has_api_key = api_key.trim().length > 0;
      configUpdates.is_enabled = api_key.trim().length > 0;
    }

    // Save model preference to settings
    if (model !== undefined) {
      await svc.from("settings").upsert(
        { key: `${provider}_model`, value: model, updated_at: now },
        { onConflict: "key" },
      );
      configUpdates.model = model;
    }

    // Save base_url to settings
    if (base_url !== undefined) {
      await svc.from("settings").upsert(
        { key: `${provider}_base_url`, value: base_url, updated_at: now },
        { onConflict: "key" },
      );
      configUpdates.base_url = base_url;
    }

    // Handle default switching — clear others first
    if (is_default === true) {
      await svc.from("ai_provider_configs")
        .update({ is_default: false, updated_at: now })
        .neq("provider", provider);
      configUpdates.is_default = true;
    }

    // Upsert the provider config record
    const { error: cfgErr } = await svc.from("ai_provider_configs").upsert(
      { provider, ...configUpdates },
      { onConflict: "provider" },
    );
    if (cfgErr) throw new Error(`Failed to update provider config: ${cfgErr.message}`);

    return ok({ success: true, provider, message: `${provider} configuration saved.` });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Internal error", 500);
  }
});
