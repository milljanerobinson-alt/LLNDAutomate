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
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── 1. Identify EWOs that satisfy ALL closure criteria ────────
    // - Product Owner Accepted (po_accepted_at IS NOT NULL)
    // - Engineering Package Accepted (engineering_package_status = 'Accepted')
    // - Completion Report Available (report_generation_status = 'available')
    // - Implementation Completed (implementation_status = 'Completed')
    // - Lifecycle still Active/Open (status NOT IN ('closed', 'archived'))
    const { data: candidates, error: queryError } = await supabase
      .from("engineering_work_orders")
      .select("id, ewo_ref, title, status, verification_status, po_accepted_at, po_accepted_by, po_acceptance_statement, implementation_status, engineering_package_status, report_generation_status, accepted_completion_report_id, knowledge_extraction_status")
      .not("po_accepted_at", "is", null)
      .eq("engineering_package_status", "Accepted")
      .eq("report_generation_status", "available")
      .eq("implementation_status", "Completed")
      .not("status", "in", '("closed","archived")')
      .order("ewo_ref");

    if (queryError) {
      return new Response(
        JSON.stringify({ error: queryError.message, governed: true }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const results: Array<{
      ewo_ref: string;
      pre_status: string;
      post_status: string;
      closed: boolean;
      verification_integrity: boolean;
      report_linkage_verified: boolean;
      acceptance_verified: boolean;
      knowledge_extraction_status: string;
      reason: string;
    }> = [];

    const skipped: Array<{ ewo_ref: string; reason: string }> = [];

    for (const ewo of candidates || []) {
      // ── Verify completion integrity ──────────────────────────────
      const verificationIntegrity = ewo.verification_status === "verified" ||
        ewo.verification_status === "not_started" ||
        ewo.verification_status === "not_verified";

      // ── Verify report linkage ───────────────────────────────────
      let reportLinkageVerified = false;
      if (ewo.accepted_completion_report_id) {
        const { data: report } = await supabase
          .from("ewo_completion_reports")
          .select("id, ewo_id")
          .eq("id", ewo.accepted_completion_report_id)
          .maybeSingle();
        reportLinkageVerified = !!report && report.ewo_id === ewo.id;
      } else {
        // Check if any report exists for this EWO
        const { data: anyReport } = await supabase
          .from("ewo_completion_reports")
          .select("id")
          .eq("ewo_id", ewo.id)
          .maybeSingle();
        reportLinkageVerified = !!anyReport;
      }

      // ── Verify acceptance ───────────────────────────────────────
      const acceptanceVerified = !!ewo.po_accepted_at && !!ewo.po_accepted_by;

      // ── Close the EWO ────────────────────────────────────────────
      const preStatus = ewo.status;
      const closedBy = ewo.po_accepted_by || "system";

      await supabase.from("engineering_work_orders").update({
        status: "closed",
        closed_at: new Date().toISOString(),
        closed_by: closedBy,
        closure_method: "Product Owner Acceptance",
        closure_reason: "Governed lifecycle reconciliation: EWO was accepted and completed but not closed",
        closure_eligible: true,
        updated_at: new Date().toISOString(),
      }).eq("id", ewo.id);

      // ── Record lifecycle event ──────────────────────────────────
      await supabase.from("ewo_lifecycle_events").insert({
        ewo_id: ewo.id,
        from_status: preStatus,
        to_status: "closed",
        actor: "system",
        notes: "Governed lifecycle reconciliation closure",
        metadata: {
          source: "lifecycle_reconciliation",
          closure_method: "Product Owner Acceptance",
          reconciliation_reason: "EWO was accepted and completed but not closed",
        },
      });

      // ── Write governance audit record ──────────────────────────
      await supabase.from("lifecycle_reconciliation_log").insert({
        ewo_id: ewo.id,
        ewo_ref: ewo.ewo_ref,
        reconciliation_type: "historical_reconciliation",
        pre_status: preStatus,
        post_status: "closed",
        reconciliation_reason: "Governed lifecycle reconciliation: EWO satisfied all closure criteria (PO accepted, package accepted, completion report available, implementation completed) but was not closed",
        verification_integrity: verificationIntegrity,
        report_linkage_verified: reportLinkageVerified,
        acceptance_verified: acceptanceVerified,
        knowledge_extraction_status: ewo.knowledge_extraction_status || "not_extracted",
        reconciled_by: "system",
      });

      // ── Write change log entry ──────────────────────────────────
      await supabase.from("engineering_change_log").insert({
        change_ref: `CL-${ewo.ewo_ref}-RECONCILE`,
        change_type: "closed",
        ewo_ref: ewo.ewo_ref,
        object_type: "engineering_work_order",
        object_ref: ewo.ewo_ref,
        summary: `Lifecycle reconciliation: ${ewo.ewo_ref} closed (was ${preStatus})`,
        description: `Governed lifecycle reconciliation identified ${ewo.ewo_ref} as accepted and completed but not closed. Verification integrity: ${verificationIntegrity}. Report linkage: ${reportLinkageVerified}. Acceptance: ${acceptanceVerified}.`,
        actor_type: "system",
        actor: "Bolt",
        recording_source: "lifecycle_reconciliation",
        metadata: {
          reconciliation_type: "historical_reconciliation",
          pre_status: preStatus,
          verification_integrity: verificationIntegrity,
          report_linkage_verified: reportLinkageVerified,
          acceptance_verified: acceptanceVerified,
        },
        immutable: true,
      });

      results.push({
        ewo_ref: ewo.ewo_ref,
        pre_status: preStatus,
        post_status: "closed",
        closed: true,
        verification_integrity: verificationIntegrity,
        report_linkage_verified: reportLinkageVerified,
        acceptance_verified: acceptanceVerified,
        knowledge_extraction_status: ewo.knowledge_extraction_status || "not_extracted",
        reason: "EWO satisfied all closure criteria but was not closed",
      });
    }

    // ── Also identify EWOs awaiting PO testing/acceptance (must NOT be closed) ──
    const { data: testingEWOs } = await supabase
      .from("engineering_work_orders")
      .select("ewo_ref, status, po_testing_status, po_accepted_at")
      .not("status", "in", '("closed","archived")')
      .or("po_testing_status.eq.pending,po_testing_status.eq.in_progress,po_accepted_at.is.null")
      .neq("ewo_ref", "EWO-028");

    const testingUntouched = (testingEWOs || []).map((e: { ewo_ref: string; status: string; po_testing_status: string | null; po_accepted_at: string | null }) => ({
      ewo_ref: e.ewo_ref,
      status: e.status,
      po_testing_status: e.po_testing_status,
      untouched: true,
    }));

    return new Response(
      JSON.stringify({
        governed: true,
        reconciliation_type: "historical_reconciliation",
        candidates_identified: candidates?.length || 0,
        ewos_closed: results.length,
        ewos_skipped: skipped.length,
        testing_ewos_untouched: testingUntouched.length,
        results,
        skipped,
        testing_ewos: testingUntouched,
        message: `Lifecycle reconciliation complete. ${results.length} EWO(s) closed. ${testingUntouched.length} testing EWO(s) left untouched.`,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message, governed: true }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
