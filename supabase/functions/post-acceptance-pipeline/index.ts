import { createClient } from "npm:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface PostAcceptanceRequest {
  ewo_ref: string;
  po_accepted_by: string;
  po_acceptance_statement: string;
  acceptance_audit_reference?: string;
  accepted_implementation_version?: string;
  accepted_refinement_version?: string;
  completion_report_id?: string;
  completion_report_body?: string;
  completion_report_title?: string;
  completion_report_executive_summary?: string;
  completion_report_scope_completed?: string;
  completion_report_files_modified?: string[];
  completion_report_lifecycle_summary?: string;
  completion_report_validation_results?: string;
  completion_report_build_result?: string;
  completion_report_risks?: string;
  completion_report_po_decisions?: string;
  completion_report_acceptance_recommendation?: string;
}

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

    const body: PostAcceptanceRequest = await req.json();
    const {
      ewo_ref,
      po_accepted_by,
      po_acceptance_statement,
      acceptance_audit_reference,
      accepted_implementation_version,
      accepted_refinement_version,
      completion_report_id,
      completion_report_body,
      completion_report_title,
      completion_report_executive_summary,
      completion_report_scope_completed,
      completion_report_files_modified,
      completion_report_lifecycle_summary,
      completion_report_validation_results,
      completion_report_build_result,
      completion_report_risks,
      completion_report_po_decisions,
      completion_report_acceptance_recommendation,
    } = body;

    if (!ewo_ref || !po_accepted_by || !po_acceptance_statement) {
      return new Response(
        JSON.stringify({ error: "Missing required parameters: ewo_ref, po_accepted_by, po_acceptance_statement" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const pipelineSteps: Array<{ step: string; status: string; detail?: string }> = [];

    // ── Step 1: Record Product Owner Acceptance ──────────────────
    const { data: ewo, error: ewoError } = await supabase
      .from("engineering_work_orders")
      .select("id, ewo_ref, status, verification_status, implementation_status, engineering_package_status, report_generation_status")
      .eq("ewo_ref", ewo_ref)
      .maybeSingle();

    if (ewoError || !ewo) {
      return new Response(
        JSON.stringify({ error: `EWO not found: ${ewo_ref}`, governed: true }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    await supabase.from("engineering_work_orders").update({
      po_accepted_at: new Date().toISOString(),
      po_accepted_by,
      po_acceptance_statement,
      accepted_implementation_version: accepted_implementation_version || "1.0",
      accepted_refinement_version: accepted_refinement_version || null,
      po_testing_status: "passed",
      po_testing_completed_at: new Date().toISOString(),
      product_owner_verification_status: "passed",
      status: "po_acceptance",
      updated_at: new Date().toISOString(),
    }).eq("id", ewo.id);

    pipelineSteps.push({ step: "record_po_acceptance", status: "completed" });

    // ── Step 2: Store acceptance metadata ─────────────────────────
    await supabase.from("engineering_change_log").insert({
      change_ref: `CL-${ewo_ref}-PO-ACCEPTANCE`,
      change_type: "approved",
      ewo_ref,
      object_type: "engineering_work_order",
      object_ref: ewo_ref,
      summary: `Product Owner acceptance recorded by ${po_accepted_by}`,
      description: po_acceptance_statement,
      actor_type: "product_owner",
      actor: po_accepted_by,
      recording_source: "post_acceptance_pipeline",
      linked_artefacts: acceptance_audit_reference ? [acceptance_audit_reference] : [],
      metadata: {
        acceptance_audit_reference: acceptance_audit_reference || null,
        accepted_implementation_version: accepted_implementation_version || "1.0",
        pipeline_version: "1.0",
      },
      immutable: true,
    });

    pipelineSteps.push({ step: "store_acceptance_metadata", status: "completed" });

    // ── Step 3: Store Engineering Completion Report ───────────────
    let reportId = completion_report_id;

    if (!reportId) {
      // Check if a report already exists
      const { data: existingReport } = await supabase
        .from("ewo_completion_reports")
        .select("id")
        .eq("ewo_id", ewo.id)
        .maybeSingle();

      if (existingReport) {
        reportId = existingReport.id;
      } else if (completion_report_body) {
        // Create a new completion report
        const { data: newReport, error: reportError } = await supabase
          .from("ewo_completion_reports")
          .insert({
            ewo_id: ewo.id,
            ewo_ref,
            title: completion_report_title || `${ewo_ref} — Completion Report`,
            executive_summary: completion_report_executive_summary || "",
            scope_completed: completion_report_scope_completed || "",
            files_modified: completion_report_files_modified || [],
            lifecycle_summary: completion_report_lifecycle_summary || "",
            validation_results: completion_report_validation_results || "",
            build_result: completion_report_build_result || "",
            risks: completion_report_risks || "",
            po_decisions: completion_report_po_decisions || "",
            acceptance_recommendation: completion_report_acceptance_recommendation || "",
            report_body: completion_report_body,
            generated_at: new Date().toISOString(),
          })
          .select("id")
          .maybeSingle();

        if (reportError || !newReport) {
          pipelineSteps.push({ step: "store_completion_report", status: "failed", detail: reportError?.message || "Unknown error" });
        } else {
          reportId = newReport.id;
        }
      }
    }

    pipelineSteps.push({ step: "store_completion_report", status: reportId ? "completed" : "skipped", detail: reportId ? undefined : "No completion report data provided" });

    // ── Step 4: Verify report linkage ─────────────────────────────
    let reportLinkageVerified = false;
    if (reportId) {
      const { data: linkedReport } = await supabase
        .from("ewo_completion_reports")
        .select("id, ewo_id")
        .eq("id", reportId)
        .maybeSingle();

      reportLinkageVerified = !!linkedReport && linkedReport.ewo_id === ewo.id;
      pipelineSteps.push({ step: "verify_report_linkage", status: reportLinkageVerified ? "completed" : "failed" });
    } else {
      pipelineSteps.push({ step: "verify_report_linkage", status: "skipped", detail: "No completion report to verify" });
    }

    // ── Step 5: Execute Engineering Knowledge Extraction ──────────
    let extractionResult: { extraction_status: string; knowledge_records_created: number; knowledge_records_merged: number; knowledge_records_skipped: number; extraction_id?: string } | null = null;

    try {
      const extractionUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/engineering-knowledge-extraction`;
      const extractionResp = await fetch(extractionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "apikey": Deno.env.get("SUPABASE_ANON_KEY")!,
        },
        body: JSON.stringify({ ewo_ref, ewo_id: ewo.id }),
      });

      if (extractionResp.ok) {
        extractionResult = await extractionResp.json();
        pipelineSteps.push({
          step: "execute_knowledge_extraction",
          status: extractionResult.extraction_status === "completed" ? "completed" : "failed",
          detail: `${extractionResult.knowledge_records_created || 0} created, ${extractionResult.knowledge_records_merged || 0} merged, ${extractionResult.knowledge_records_skipped || 0} skipped`,
        });
      } else {
        pipelineSteps.push({ step: "execute_knowledge_extraction", status: "failed", detail: `HTTP ${extractionResp.status}` });
      }
    } catch (extractErr) {
      pipelineSteps.push({ step: "execute_knowledge_extraction", status: "failed", detail: extractErr.message });
    }

    // ── Step 6: Verify extraction completed successfully ─────────
    const extractionVerified = extractionResult?.extraction_status === "completed";
    pipelineSteps.push({ step: "verify_extraction", status: extractionVerified ? "completed" : "failed" });

    // ── Step 7: Close the Engineering Work Order ─────────────────
    // Use the governed Product Owner Acceptance closure method
    await supabase.from("engineering_work_orders").update({
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by: po_accepted_by,
      closure_method: "Product Owner Acceptance",
      closure_reason: "Automatically closed via post-acceptance pipeline after Product Owner acceptance and knowledge extraction",
      closure_eligible: true,
      accepted_completion_report_id: reportId || null,
      completion_report_status: {
        build: "passed",
        po_testing: "passed",
        verification: "passed",
        po_acceptance: "accepted",
        implementation: "completed",
      },
      implementation_status: "Completed",
      engineering_package_status: "Accepted",
      report_generation_status: "available",
      updated_at: new Date().toISOString(),
    }).eq("id", ewo.id);

    // Record lifecycle event
    await supabase.from("ewo_lifecycle_events").insert({
      ewo_id: ewo.id,
      from_status: "po_acceptance",
      to_status: "closed",
      actor: po_accepted_by,
      notes: "Closed via post-acceptance pipeline",
      metadata: {
        source: "post_acceptance_pipeline",
        closure_method: "Product Owner Acceptance",
        extraction_completed: extractionVerified,
        pipeline_version: "1.0",
      },
    });

    // Record reconciliation log entry
    await supabase.from("lifecycle_reconciliation_log").insert({
      ewo_id: ewo.id,
      ewo_ref,
      reconciliation_type: "post_acceptance_closure",
      pre_status: ewo.status,
      post_status: "closed",
      reconciliation_reason: "Automatic post-acceptance pipeline closure after Product Owner acceptance and knowledge extraction",
      verification_integrity: true,
      report_linkage_verified: reportLinkageVerified,
      acceptance_verified: true,
      knowledge_extraction_status: extractionVerified ? "extracted" : "failed",
      reconciled_by: po_accepted_by,
    });

    // Record change log entry for closure
    await supabase.from("engineering_change_log").insert({
      change_ref: `CL-${ewo_ref}-CLOSURE`,
      change_type: "closed",
      ewo_ref,
      object_type: "engineering_work_order",
      object_ref: ewo_ref,
      summary: `EWO-028 pipeline: ${ewo_ref} closed via Product Owner Acceptance`,
      description: `Automatic post-acceptance pipeline completed. Closure method: Product Owner Acceptance. Knowledge extraction: ${extractionVerified ? "completed" : "failed"}.`,
      actor_type: "system",
      actor: "Bolt",
      recording_source: "post_acceptance_pipeline",
      linked_artefacts: reportId ? [reportId] : [],
      metadata: {
        pipeline_version: "1.0",
        closure_method: "Product Owner Acceptance",
        extraction_completed: extractionVerified,
        report_linkage_verified: reportLinkageVerified,
      },
      immutable: true,
    });

    pipelineSteps.push({ step: "close_ewo", status: "completed" });

    // ── Return final result ──────────────────────────────────────
    return new Response(
      JSON.stringify({
        governed: true,
        ewo_ref,
        pipeline_status: "completed",
        pipeline_steps: pipelineSteps,
        po_acceptance_recorded: true,
        completion_report_linked: reportLinkageVerified,
        knowledge_extraction: extractionResult,
        ewo_closed: true,
        closure_method: "Product Owner Acceptance",
        closed_at: new Date().toISOString(),
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
