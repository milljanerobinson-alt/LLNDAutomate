import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Issue #45: platform operators with MFA only (trusted server-to-server calls with the service-role key also pass).
  {
    const operatorCheck = await requirePlatformOperator(req.headers.get("Authorization"), { allowServiceRole: true });
    if (!operatorCheck.ok) return operatorDeniedResponse(operatorCheck, corsHeaders);
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const url = new URL(req.url);
    const operation = url.pathname.split("/").pop() || "";

    // ─── GET: inspect_ewo_acceptance_state ───
    if (req.method === "GET") {
      const ewoRef = url.searchParams.get("ewo_ref");
      if (!ewoRef) {
        return new Response(
          JSON.stringify({ error: "ewo_ref parameter is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data, error } = await supabase
        .rpc("inspect_ewo_acceptance_state", { p_ewo_ref: ewoRef });

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify(data),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── POST: grant_governed_product_owner_acceptance ───
    if (req.method === "POST") {
      const body = await req.json();
      const {
        ewo_ref,
        po_identity,
        po_decision,
        live_test_result_ref,
        acceptance_command_ref,
        source_conversation_ref,
        audit_ref,
        acceptance_statement,
        explicit_lifecycle_change,
        unresolved_blockers,
      } = body;

      if (!ewo_ref || !po_identity || !po_decision || !live_test_result_ref ||
          !acceptance_command_ref || !audit_ref) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Missing required fields. Required: ewo_ref, po_identity, po_decision, live_test_result_ref, acceptance_command_ref, audit_ref",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data, error } = await supabase
        .rpc("grant_governed_product_owner_acceptance", {
          p_ewo_ref: ewo_ref,
          p_po_identity: po_identity,
          p_po_decision: po_decision,
          p_live_test_result_ref: live_test_result_ref,
          p_acceptance_command_ref: acceptance_command_ref,
          p_source_conversation_ref: source_conversation_ref ?? null,
          p_audit_ref: audit_ref,
          p_acceptance_statement: acceptance_statement ?? null,
          p_explicit_lifecycle_change: explicit_lifecycle_change ?? true,
          p_unresolved_blockers: unresolved_blockers ?? false,
        });

      if (error) {
        return new Response(
          JSON.stringify({ success: false, error: error.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify(data),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
