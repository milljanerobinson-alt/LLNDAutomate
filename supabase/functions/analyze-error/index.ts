import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";
import { loadAIConfig, generate } from "../_shared/ai-service.ts";

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
    const svc = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { error_id } = await req.json();
    if (!error_id) {
      return new Response(JSON.stringify({ error: "error_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: record, error: fetchErr } = await svc
      .from("ecc_error_records")
      .select("*")
      .eq("id", error_id)
      .maybeSingle();

    if (fetchErr || !record) {
      return new Response(JSON.stringify({ error: "Error record not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const config = await loadAIConfig(svc);
    if (!config) {
      return new Response(JSON.stringify({ error: "AI provider not configured" }), {
        status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const prompt = buildAnalysisPrompt(record);

    const aiResp = await generate(config, {
      feature: "eeif-analyze-error",
      messages: [{ role: "user", content: prompt }],
      maxTokens: 2000,
      temperature: 0.3,
    });

    const analysis = parseAnalysis(aiResp.content);

    const { error: updateErr } = await svc
      .from("ecc_error_records")
      .update({
        ai_root_cause:        analysis.root_cause,
        ai_explanation:       analysis.explanation,
        ai_recommended_fix:   analysis.recommended_fix,
        ai_impact_assessment: analysis.impact_assessment,
        ai_prevention:        analysis.prevention,
        ai_confidence:        analysis.confidence,
        ai_analysed_at:       new Date().toISOString(),
        updated_at:           new Date().toISOString(),
      })
      .eq("id", error_id);

    if (updateErr) {
      return new Response(JSON.stringify({ error: "Failed to save analysis", detail: updateErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, analysis }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildAnalysisPrompt(r: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("You are an expert AI Technical Director conducting root cause analysis on a software error.");
  lines.push("Analyse the error below and provide a structured, actionable report.");
  lines.push("");
  lines.push("## Error Record");
  lines.push(`Title: ${r.title}`);
  lines.push(`Type: ${r.error_type}`);
  lines.push(`Severity: ${r.severity}`);
  lines.push(`Message: ${r.message}`);
  if (r.stack_trace) lines.push(`\nStack Trace:\n${r.stack_trace}`);
  if (r.component_path) lines.push(`Component/File: ${r.component_path}`);
  if (r.page_url) lines.push(`Page URL: ${r.page_url}`);
  if (r.request_context) lines.push(`Request Context: ${JSON.stringify(r.request_context)}`);
  if (r.response_context) lines.push(`Response Context: ${JSON.stringify(r.response_context)}`);
  if (r.extra_context) lines.push(`Extra Context: ${JSON.stringify(r.extra_context)}`);
  lines.push(`Occurrences: ${r.occurrence_count}`);
  lines.push(`First Seen: ${r.first_seen_at}`);
  lines.push(`Last Seen: ${r.last_seen_at}`);

  lines.push("");
  lines.push("## Required Output Format");
  lines.push("Return ONLY valid JSON matching this exact structure:");
  lines.push(`{
  "root_cause": "Technical root cause — what went wrong and why (2-4 sentences, technical)",
  "explanation": "Plain-English explanation a non-engineer could understand (1-2 sentences)",
  "recommended_fix": "Step-by-step fix instructions (numbered list as a single string, use \\n for newlines)",
  "impact_assessment": "What is broken, what users/features are affected (1-2 sentences)",
  "prevention": "How to prevent this class of error in future (1-2 sentences)",
  "confidence": "high|medium|low"
}`);

  return lines.join("\n");
}

// ─── Response parser ──────────────────────────────────────────────────────────

function parseAnalysis(raw: string): Record<string, string> {
  const stripped = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```$/m, "")
    .trim();

  try {
    const parsed = JSON.parse(stripped);
    return {
      root_cause:        String(parsed.root_cause        ?? ""),
      explanation:       String(parsed.explanation       ?? ""),
      recommended_fix:   String(parsed.recommended_fix   ?? ""),
      impact_assessment: String(parsed.impact_assessment ?? ""),
      prevention:        String(parsed.prevention        ?? ""),
      confidence:        String(parsed.confidence        ?? "medium"),
    };
  } catch {
    const first = raw.indexOf("{");
    const last  = raw.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        const parsed = JSON.parse(raw.slice(first, last + 1));
        return {
          root_cause:        String(parsed.root_cause        ?? ""),
          explanation:       String(parsed.explanation       ?? ""),
          recommended_fix:   String(parsed.recommended_fix   ?? ""),
          impact_assessment: String(parsed.impact_assessment ?? ""),
          prevention:        String(parsed.prevention        ?? ""),
          confidence:        String(parsed.confidence        ?? "medium"),
        };
      } catch { /* fall through */ }
    }
    return {
      root_cause:        "Analysis could not be parsed from AI response.",
      explanation:       "The AI Technical Director was unable to provide a structured analysis.",
      recommended_fix:   "Review the error manually.",
      impact_assessment: "Unknown impact.",
      prevention:        "Unknown.",
      confidence:        "low",
    };
  }
}
