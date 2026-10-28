// Issue #45 — read-only platform support access to one RTO.
//
// Every request must come from an MFA-verified platform operator with an
// active support session. The organisation comes from that session, never from
// the request. Each view is recorded (record_operator_access, attributed from
// the operator's own token) BEFORE any data is returned; if recording fails,
// nothing is returned. Views are customer-safe summaries: no settings, no
// credentials or secrets, no Stripe identifiers or card details, no candidate
// answers, and no raw integration payloads or error bodies.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { callerClient, operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

export const SUPPORT_RESOURCES = [
  "organisation_summary",
  "staff_list",
  "integration_status",
  "email_activity",
  "qualification_list",
  "subscription_status",
] as const;
type SupportResource = typeof SUPPORT_RESOURCES[number];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

export function maskEmail(email: string | null | undefined): string {
  if (!email || !email.includes("@")) return "";
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

// deno-lint-ignore no-explicit-any
type Db = any;

async function readResource(db: Db, organisationId: string, resource: SupportResource): Promise<{ data: unknown; count: number }> {
  switch (resource) {
    case "organisation_summary": {
      const [{ data: org }, { data: members }, { count: candidates }, { count: openCases }, { data: integration }] = await Promise.all([
        db.from("organisations").select("id, name, created_at").eq("id", organisationId).maybeSingle(),
        db.from("organisation_memberships").select("status").eq("organisation_id", organisationId),
        db.from("students").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId),
        db.from("support_cases").select("id", { count: "exact", head: true }).eq("organisation_id", organisationId).neq("status", "resolved"),
        db.from("settings").select("value").eq("key", "legacy_server_settings_organisation_id").maybeSingle(),
      ]);
      const byStatus: Record<string, number> = {};
      for (const m of (members ?? []) as Array<{ status: string }>) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
      return {
        data: {
          organisation: org,
          staff_by_status: byStatus,
          candidate_count: candidates ?? 0,
          open_support_cases: openCases ?? 0,
          owns_platform_axcelerate_integration: integration?.value === organisationId,
        },
        count: 1,
      };
    }
    case "staff_list": {
      const { data: members } = await db.from("organisation_memberships")
        .select("user_id, status, activated_at, deactivated_at, created_at").eq("organisation_id", organisationId);
      const ids = (members ?? []).map((m: { user_id: string }) => m.user_id);
      const [{ data: profiles }, { data: access }] = await Promise.all([
        ids.length ? db.from("profiles").select("id, full_name, email").in("id", ids) : { data: [] },
        db.from("user_workspace_access").select("user_id, workspace").eq("organisation_id", organisationId),
      ]);
      const profileById = new Map((profiles ?? []).map((p: { id: string }) => [p.id, p]));
      const rows = (members ?? []).map((m: { user_id: string; status: string; activated_at: string | null; deactivated_at: string | null; created_at: string }) => {
        const p = profileById.get(m.user_id) as { full_name?: string; email?: string } | undefined;
        return {
          name: p?.full_name ?? "",
          email: p?.email ?? "",
          status: m.status,
          workspaces: (access ?? []).filter((a: { user_id: string }) => a.user_id === m.user_id).map((a: { workspace: string }) => a.workspace),
          activated_at: m.activated_at,
          deactivated_at: m.deactivated_at,
          joined_at: m.created_at,
        };
      });
      return { data: rows, count: rows.length };
    }
    case "integration_status": {
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const [{ data: queue }, { data: syncs }] = await Promise.all([
        db.from("axcelerate_writeback_queue").select("event_type, status, last_attempted_at").eq("organisation_id", organisationId).gte("created_at", since),
        db.from("axcelerate_sync_log").select("sync_type, status, synced_at").eq("organisation_id", organisationId).gte("synced_at", since),
      ]);
      const tally = (rows: Array<Record<string, string>>, a: string, b: string) => {
        const out: Record<string, number> = {};
        for (const r of rows ?? []) { const k = `${r[a]}:${r[b]}`; out[k] = (out[k] ?? 0) + 1; }
        return out;
      };
      const latest = (rows: Array<Record<string, string | null>>, key: string) =>
        (rows ?? []).map((r) => r[key]).filter(Boolean).sort().at(-1) ?? null;
      return {
        data: {
          period_days: 30,
          writeback_jobs_by_type_and_status: tally(queue ?? [], "event_type", "status"),
          sync_events_by_type_and_status: tally(syncs ?? [], "sync_type", "status"),
          last_writeback_attempt: latest(queue ?? [], "last_attempted_at"),
          last_sync: latest(syncs ?? [], "synced_at"),
        },
        count: (queue?.length ?? 0) + (syncs?.length ?? 0),
      };
    }
    case "email_activity": {
      const { data: emails } = await db.from("email_queue")
        .select("email_type, status, recipient_email, scheduled_at, last_attempted_at, attempts")
        .eq("organisation_id", organisationId).order("scheduled_at", { ascending: false }).limit(50);
      const rows = (emails ?? []).map((e: { email_type: string; status: string; recipient_email: string; scheduled_at: string; last_attempted_at: string | null; attempts: number }) => ({
        email_type: e.email_type,
        status: e.status,
        recipient: maskEmail(e.recipient_email),
        scheduled_at: e.scheduled_at,
        last_attempted_at: e.last_attempted_at,
        attempts: e.attempts,
      }));
      return { data: rows, count: rows.length };
    }
    case "qualification_list": {
      const { data: quals } = await db.from("qualifications")
        .select("code, name, active, mapping_status").eq("organisation_id", organisationId).order("code");
      return { data: quals ?? [], count: quals?.length ?? 0 };
    }
    case "subscription_status": {
      const { data: subs } = await db.from("subscriptions")
        .select("plan_id, status, trial_ends_at, current_period_start, current_period_end, cancel_at_period_end, created_at")
        .eq("organisation_id", organisationId).order("created_at", { ascending: false }).limit(5);
      return { data: subs ?? [], count: subs?.length ?? 0 };
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // MFA-verified platform operators only; no service-role bypass.
  const authHeader = req.headers.get("Authorization");
  const operatorCheck = await requirePlatformOperator(authHeader, { allowServiceRole: false });
  if (!operatorCheck.ok) return operatorDeniedResponse(operatorCheck, corsHeaders);

  const body = await req.json().catch(() => ({}));
  const resource = body?.resource as SupportResource;
  if (!SUPPORT_RESOURCES.includes(resource)) return json({ error: "Unknown support view" }, 400);

  // The organisation comes from the operator's own active session.
  const caller = callerClient(authHeader!);
  const { data: sessions, error: sessionError } = await caller.rpc("active_operator_support_session");
  const session = Array.isArray(sessions) ? sessions[0] : null;
  if (sessionError || !session?.organisation_id) {
    return json({ error: "Start a support session for an RTO first" }, 409);
  }
  if (body?.organisation_id && body.organisation_id !== session.organisation_id) {
    return json({ error: "That RTO is not the one selected for this support session" }, 409);
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, count } = await readResource(db, session.organisation_id, resource);

  // Record before returning anything; fail closed.
  const { error: auditError } = await caller.rpc("record_operator_access", { p_resource: resource, p_record_count: count, p_rto_visible: true });
  if (auditError) return json({ error: "Support access could not be recorded, so nothing was returned" }, 500);

  return json({
    organisation: { id: session.organisation_id, name: session.organisation_name },
    session: { reason: session.reason, expires_at: session.expires_at },
    resource,
    data,
  });
});
