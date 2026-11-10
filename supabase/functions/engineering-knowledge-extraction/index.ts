import { createClient } from "npm:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ExtractionRequest {
  ewo_ref: string;
  ewo_id?: string;
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

    const body: ExtractionRequest = await req.json();
    const { ewo_ref } = body;

    if (!ewo_ref) {
      return new Response(
        JSON.stringify({ error: "Missing required parameter: ewo_ref" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── 1. Retrieve the EWO ──────────────────────────────────────
    const { data: ewo, error: ewoError } = await supabase
      .from("engineering_work_orders")
      .select("id, ewo_ref, title, executive_summary, engineering_objective, scope, status, verification_status, po_accepted_at, po_accepted_by, po_acceptance_statement, implementation_status, engineering_package_status, accepted_implementation_version, accepted_refinement_version, changed_files, implementation_summary, validation_notes, engineering_notes, knowledge_extraction_status")
      .eq("ewo_ref", ewo_ref)
      .maybeSingle();

    if (ewoError || !ewo) {
      return new Response(
        JSON.stringify({ error: `EWO not found: ${ewo_ref}`, governed: true }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Idempotency check ─────────────────────────────────────────
    const { data: existingExtraction } = await supabase
      .from("engineering_knowledge_extractions")
      .select("id, extraction_status, knowledge_records_created, knowledge_records_merged, knowledge_records_skipped")
      .eq("ewo_id", ewo.id)
      .maybeSingle();

    if (existingExtraction && existingExtraction.extraction_status === "completed") {
      return new Response(
        JSON.stringify({
          governed: true,
          ewo_ref,
          extraction_status: "completed",
          idempotent: true,
          extraction_id: existingExtraction.id,
          knowledge_records_created: existingExtraction.knowledge_records_created,
          knowledge_records_merged: existingExtraction.knowledge_records_merged,
          knowledge_records_skipped: existingExtraction.knowledge_records_skipped,
          message: "Knowledge extraction already completed for this EWO",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── 2. Retrieve completion report ──────────────────────────────
    const { data: completionReport } = await supabase
      .from("ewo_completion_reports")
      .select("id, title, executive_summary, scope_completed, files_modified, database_changes, lifecycle_summary, validation_results, build_result, risks, po_decisions, acceptance_recommendation, report_body")
      .eq("ewo_id", ewo.id)
      .maybeSingle();

    // ── 3. Retrieve engineering records ───────────────────────────
    const { data: records } = await supabase
      .from("engineering_records_library")
      .select("id, record_ref, title, engineering_objective, implementation_summary, validation_summary, po_acceptance_detail, engineering_knowledge, semantic_metadata")
      .eq("ewo_id", ewo.id);

    // ── 4. Retrieve change log entries ────────────────────────────
    const { data: changeLogEntries } = await supabase
      .from("engineering_change_log")
      .select("change_ref, change_type, summary, description, created_at")
      .eq("ewo_ref", ewo_ref)
      .order("created_at", { ascending: true });

    // ── 5. Create or update extraction record ─────────────────────
    const extractionId = existingExtraction?.id || crypto.randomUUID();
    const extractionDiagnostics: Record<string, unknown> = {
      ewo_found: true,
      completion_report_found: !!completionReport,
      engineering_records_count: records?.length || 0,
      change_log_entries: changeLogEntries?.length || 0,
      ewo_status: ewo.status,
      verification_status: ewo.verification_status,
      po_accepted: !!ewo.po_accepted_at,
      extraction_method: "deterministic",
      extraction_rules_version: "1.0",
    };

    if (!existingExtraction) {
      await supabase.from("engineering_knowledge_extractions").insert({
        id: extractionId,
        ewo_id: ewo.id,
        ewo_ref,
        extraction_status: "running",
        extraction_method: "deterministic",
        completion_report_id: completionReport?.id || null,
        extraction_diagnostics: extractionDiagnostics,
      });
    } else {
      await supabase.from("engineering_knowledge_extractions").update({
        extraction_status: "running",
        extraction_diagnostics: extractionDiagnostics,
        completion_report_id: completionReport?.id || null,
      }).eq("id", extractionId);
    }

    // Update EWO knowledge_extraction_status
    await supabase.from("engineering_work_orders")
      .update({ knowledge_extraction_status: "extracting" })
      .eq("id", ewo.id);

    // ── 6. Analyse artefacts and extract knowledge ────────────────
    // Deterministic rule-based extraction — NO AI/LLM calls
    const extractedKnowledge: Array<{
      knowledge_category: string;
      title: string;
      content: string;
      tags: string[];
      source_section: string;
    }> = [];

    // Rule 1: Extract from EWO executive summary — implementation technique
    if (ewo.executive_summary) {
      extractedKnowledge.push({
        knowledge_category: "implementation_strategy",
        title: `${ewo_ref}: Implementation Approach`,
        content: ewo.executive_summary,
        tags: [ewo_ref, "implementation_strategy", ewo.implementation_status || "completed"],
        source_section: "ewo_executive_summary",
      });
    }

    // Rule 2: Extract from EWO engineering objective — architectural pattern
    if (ewo.engineering_objective) {
      extractedKnowledge.push({
        knowledge_category: "architecture",
        title: `${ewo_ref}: Engineering Objective & Architecture`,
        content: ewo.engineering_objective,
        tags: [ewo_ref, "architecture", "engineering_objective"],
        source_section: "ewo_engineering_objective",
      });
    }

    // Rule 3: Extract from completion report — validation pattern
    if (completionReport?.validation_results) {
      extractedKnowledge.push({
        knowledge_category: "validation_outcome",
        title: `${ewo_ref}: Validation Results & Testing Patterns`,
        content: completionReport.validation_results,
        tags: [ewo_ref, "validation", "testing_pattern"],
        source_section: "completion_report_validation_results",
      });
    }

    // Rule 4: Extract from completion report — lifecycle summary
    if (completionReport?.lifecycle_summary) {
      extractedKnowledge.push({
        knowledge_category: "lesson_learned",
        title: `${ewo_ref}: Lifecycle Summary & Lessons Learned`,
        content: completionReport.lifecycle_summary,
        tags: [ewo_ref, "lifecycle", "lesson_learned"],
        source_section: "completion_report_lifecycle_summary",
      });
    }

    // Rule 5: Extract from completion report — risks (anti-pattern)
    if (completionReport?.risks) {
      extractedKnowledge.push({
        knowledge_category: "anti_pattern",
        title: `${ewo_ref}: Risks & Anti-Patterns Identified`,
        content: completionReport.risks,
        tags: [ewo_ref, "risks", "anti_pattern"],
        source_section: "completion_report_risks",
      });
    }

    // Rule 6: Extract from completion report — build result (implementation technique)
    if (completionReport?.build_result) {
      extractedKnowledge.push({
        knowledge_category: "implementation_strategy",
        title: `${ewo_ref}: Build Result & Implementation Technique`,
        content: completionReport.build_result,
        tags: [ewo_ref, "build", "implementation_technique"],
        source_section: "completion_report_build_result",
      });
    }

    // Rule 7: Extract from completion report — PO decisions (governance rule)
    if (completionReport?.po_decisions) {
      extractedKnowledge.push({
        knowledge_category: "engineering_decision",
        title: `${ewo_ref}: Product Owner Decisions & Governance Rules`,
        content: completionReport.po_decisions,
        tags: [ewo_ref, "po_decisions", "governance"],
        source_section: "completion_report_po_decisions",
      });
    }

    // Rule 8: Extract from completion report — acceptance recommendation
    if (completionReport?.acceptance_recommendation) {
      extractedKnowledge.push({
        knowledge_category: "engineering_decision",
        title: `${ewo_ref}: Acceptance Recommendation`,
        content: completionReport.acceptance_recommendation,
        tags: [ewo_ref, "acceptance", "governance"],
        source_section: "completion_report_acceptance_recommendation",
      });
    }

    // Rule 9: Extract from engineering records — engineering knowledge
    for (const record of records || []) {
      if (record.engineering_knowledge) {
        const knowledgeData = typeof record.engineering_knowledge === "string"
          ? JSON.parse(record.engineering_knowledge)
          : record.engineering_knowledge;
        if (knowledgeData && typeof knowledgeData === "object") {
          for (const [key, value] of Object.entries(knowledgeData)) {
            if (typeof value === "string" && value.trim().length > 10) {
              extractedKnowledge.push({
                knowledge_category: "lesson_learned",
                title: `${ewo_ref}: ${key.replace(/_/g, " ")}`,
                content: value,
                tags: [ewo_ref, record.record_ref, key],
                source_section: `engineering_record:${record.record_ref}`,
              });
            }
          }
        }
      }
      if (record.implementation_summary) {
        extractedKnowledge.push({
          knowledge_category: "implementation_strategy",
          title: `${ewo_ref}: Implementation Summary (${record.record_ref})`,
          content: record.implementation_summary,
          tags: [ewo_ref, record.record_ref, "implementation_summary"],
          source_section: `engineering_record:${record.record_ref}:implementation_summary`,
        });
      }
      if (record.validation_summary) {
        extractedKnowledge.push({
          knowledge_category: "validation_outcome",
          title: `${ewo_ref}: Validation Summary (${record.record_ref})`,
          content: record.validation_summary,
          tags: [ewo_ref, record.record_ref, "validation_summary"],
          source_section: `engineering_record:${record.record_ref}:validation_summary`,
        });
      }
    }

    // Rule 10: Extract from EWO validation notes — testing pattern
    if (ewo.validation_notes) {
      extractedKnowledge.push({
        knowledge_category: "validation_outcome",
        title: `${ewo_ref}: Validation Notes & Testing Patterns`,
        content: ewo.validation_notes,
        tags: [ewo_ref, "validation", "testing_pattern"],
        source_section: "ewo_validation_notes",
      });
    }

    // Rule 11: Extract from EWO engineering notes — lessons learned
    if (ewo.engineering_notes) {
      extractedKnowledge.push({
        knowledge_category: "lesson_learned",
        title: `${ewo_ref}: Engineering Notes & Lessons Learned`,
        content: ewo.engineering_notes,
        tags: [ewo_ref, "engineering_notes", "lesson_learned"],
        source_section: "ewo_engineering_notes",
      });
    }

    // Rule 12: Extract from change log — recurring fixes
    if (changeLogEntries && changeLogEntries.length > 0) {
      const changeSummaries = changeLogEntries
        .map((e: { change_ref: string; change_type: string; summary: string; created_at: string }) =>
          `[${e.change_type}] ${e.summary}`)
        .join("\n");
      extractedKnowledge.push({
        knowledge_category: "lesson_learned",
        title: `${ewo_ref}: Change History & Recurring Fixes`,
        content: changeSummaries,
        tags: [ewo_ref, "change_history", "recurring_fixes"],
        source_section: "engineering_change_log",
      });
    }

    // ── 7. Deduplicate against existing knowledge ────────────────
    let created = 0;
    let merged = 0;
    let skipped = 0;

    // Get existing knowledge records for this EWO to check for duplicates
    const { data: existingMemory } = await supabase
      .from("engineering_memory")
      .select("id, title, content, knowledge_category, tags, record_id")
      .in("knowledge_category", [
        "architecture", "pattern", "lesson_learned", "anti_pattern",
        "reusable_component", "known_risk", "implementation_strategy",
        "validation_outcome", "engineering_decision",
      ]);

    // We need a parent engineering record for the memory entries.
    // Find or create one for this EWO.
    let parentRecordId: string | null = null;
    if (records && records.length > 0) {
      parentRecordId = records[0].id;
    } else {
      // Create a minimal engineering record for this EWO if none exists
      const { data: newRecord, error: recordError } = await supabase
        .from("engineering_records_library")
        .insert({
          record_ref: `ER-${ewo_ref}`,
          record_type: "engineering_record",
          title: `Engineering Record for ${ewo_ref}`,
          ewo_id: ewo.id,
          ewo_ref,
          status: "complete",
          content: ewo.executive_summary || ewo.title,
          implementation_summary: ewo.implementation_summary || ewo.executive_summary,
          engineering_knowledge: {},
          engineering_objective: ewo.engineering_objective,
          knowledge_extracted: true,
          record_version: 1,
        })
        .select("id")
        .maybeSingle();

      if (!recordError && newRecord) {
        parentRecordId = newRecord.id;
      }
    }

    if (!parentRecordId) {
      // Cannot create knowledge records without a parent — skip extraction
      await supabase.from("engineering_knowledge_extractions").update({
        extraction_status: "failed",
        extraction_diagnostics: {
          ...extractionDiagnostics,
          error: "No parent engineering record available and could not create one",
        },
        extracted_at: new Date().toISOString(),
      }).eq("id", extractionId);

      await supabase.from("engineering_work_orders")
        .update({ knowledge_extraction_status: "failed" })
        .eq("id", ewo.id);

      return new Response(
        JSON.stringify({
          governed: true,
          ewo_ref,
          extraction_status: "failed",
          error: "Could not establish parent engineering record for knowledge storage",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    for (const knowledge of extractedKnowledge) {
      // Check for duplicate by title + knowledge_category
      const duplicate = (existingMemory || []).find(
        (m: { title: string; knowledge_category: string }) =>
          m.title === knowledge.title && m.knowledge_category === knowledge.knowledge_category,
      );

      if (duplicate) {
        // Check if content is identical — if so skip, if different merge
        if (duplicate.content === knowledge.content) {
          skipped++;
          continue;
        }

        // Merge: update the existing record with new content appended
        const mergedContent = `${duplicate.content}\n\n--- Updated from ${ewo_ref} ---\n${knowledge.content}`;
        const mergedTags = Array.from(new Set([
          ...(duplicate.tags || []),
          ...knowledge.tags,
        ]));

        await supabase.from("engineering_memory").update({
          content: mergedContent,
          tags: mergedTags,
        }).eq("id", duplicate.id);

        // Record provenance for the merged record
        await supabase.from("engineering_knowledge_provenance").insert({
          knowledge_record_id: duplicate.id,
          ewo_id: ewo.id,
          ewo_ref,
          implementation_version: ewo.accepted_implementation_version || "1.0",
          completion_report_id: completionReport?.id || null,
          acceptance_audit_reference: ewo.po_acceptance_statement || null,
          extraction_id: extractionId,
        });

        merged++;
        continue;
      }

      // Create new knowledge record
      const { data: newMemory, error: memoryError } = await supabase
        .from("engineering_memory")
        .insert({
          record_id: parentRecordId,
          record_ref: `ER-${ewo_ref}`,
          knowledge_category: knowledge.knowledge_category,
          title: knowledge.title,
          content: knowledge.content,
          source_section: knowledge.source_section,
          tags: knowledge.tags,
          authority_state: "provisional",
        })
        .select("id")
        .maybeSingle();

      if (memoryError || !newMemory) {
        skipped++;
        continue;
      }

      // Record provenance
      await supabase.from("engineering_knowledge_provenance").insert({
        knowledge_record_id: newMemory.id,
        ewo_id: ewo.id,
        ewo_ref,
        implementation_version: ewo.accepted_implementation_version || "1.0",
        completion_report_id: completionReport?.id || null,
        acceptance_audit_reference: ewo.po_acceptance_statement || null,
        extraction_id: extractionId,
      });

      created++;
    }

    // ── 8. Update extraction record ───────────────────────────────
    const finalDiagnostics = {
      ...extractionDiagnostics,
      knowledge_candidates: extractedKnowledge.length,
      records_created: created,
      records_merged: merged,
      records_skipped: skipped,
      extraction_completed_at: new Date().toISOString(),
    };

    await supabase.from("engineering_knowledge_extractions").update({
      extraction_status: "completed",
      knowledge_records_created: created,
      knowledge_records_merged: merged,
      knowledge_records_skipped: skipped,
      extraction_diagnostics: finalDiagnostics,
      extracted_at: new Date().toISOString(),
    }).eq("id", extractionId);

    // Update EWO knowledge_extraction_status
    await supabase.from("engineering_work_orders")
      .update({ knowledge_extraction_status: "extracted" })
      .eq("id", ewo.id);

    // Record change log entry
    await supabase.from("engineering_change_log").insert({
      change_ref: `CL-${ewo_ref}-EXTRACTION`,
      change_type: "updated",
      ewo_ref,
      object_type: "engineering_knowledge",
      object_ref: ewo_ref,
      summary: `Knowledge extraction completed: ${created} created, ${merged} merged, ${skipped} skipped`,
      description: `Deterministic knowledge extraction from ${ewo_ref} artefacts. ${extractedKnowledge.length} candidates identified, ${created} new records, ${merged} merged, ${skipped} duplicates skipped.`,
      actor_type: "system",
      actor: "Bolt",
      recording_source: "knowledge_extraction_pipeline",
      immutable: true,
    });

    return new Response(
      JSON.stringify({
        governed: true,
        ewo_ref,
        extraction_status: "completed",
        extraction_id: extractionId,
        knowledge_records_created: created,
        knowledge_records_merged: merged,
        knowledge_records_skipped: skipped,
        knowledge_candidates: extractedKnowledge.length,
        completion_report_linked: !!completionReport,
        provenance_recorded: true,
        diagnostics: finalDiagnostics,
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
