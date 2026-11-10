// EWO-016 — Built-in OpenAI Engineering Review
// Receives a governed Review Package and invokes the configured review provider
// (default: OpenAI). The review appears inside ATD — the Product Owner does not
// need to copy the Completion Report into an external ChatGPT conversation.
//
// IMPORTANT: The reviewer must NOT grant Product Owner Verification or Acceptance.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createServiceClient, generate } from "../_shared/ai-service.ts";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ReviewPackageRequest {
  executionId: string;
  ewoRef: string;
  ewoTitle: string;
  ewoDescription: string;
  requirements: string;
  acceptanceCriteria: string;
  completionReportSummary: string;
  filesChanged: string[];
  buildEvidence: string;
  testEvidence: string;
  verificationEvidence: string;
  applicableStandards: string[];
  constitutionalRequirements: string[];
  knownRisks: string[];
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
    const body: ReviewPackageRequest = await req.json();

    // Validate required fields
    if (!body.executionId || !body.ewoRef) {
      return new Response(
        JSON.stringify({ error: "executionId and ewoRef are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const svc = createServiceClient();

    // Build the governed review prompt
    const reviewPrompt = buildReviewPrompt(body);

    // Invoke the configured review provider (default: OpenAI)
    const aiResponse = await generate(svc, {
      feature: "engineering_review",
      messages: [
        { role: "system", content: REVIEW_SYSTEM_PROMPT },
        { role: "user", content: reviewPrompt },
      ],
      temperature: 0.3,
      maxTokens: 4096,
    });

    // Parse the review into structured sections
    const review = parseReviewResponse(aiResponse.content, body.ewoRef);

    // Store the review result on the execution
    await svc.from("engineering_executions")
      .update({
        review_results: {
          ...review,
          provider: aiResponse.provider,
          model: aiResponse.model,
          reviewed_at: new Date().toISOString(),
          prompt_tokens: aiResponse.promptTokens,
          completion_tokens: aiResponse.completionTokens,
        },
      })
      .eq("id", body.executionId);

    // Record audit event
    await svc.from("engineering_execution_events").insert({
      execution_id: body.executionId,
      event_type: "engineering_review_completed",
      from_status: "engineering_review",
      to_status: "automated_verification",
      actor: "openai_reviewer",
      notes: `Review by ${aiResponse.provider}/${aiResponse.model}. Verdict: ${review.verdict}`,
    });

    return new Response(
      JSON.stringify({
        success: true,
        review,
        provider: aiResponse.provider,
        model: aiResponse.model,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Review failed",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

const REVIEW_SYSTEM_PROMPT = `You are an Engineering Reviewer for the EIOS Engineering Control Centre.
Your role is to review completed engineering work against its requirements, standards, and constitutional governance.

You MUST:
1. Evaluate requirement satisfaction — were all requirements met?
2. Evaluate architecture — does the implementation follow good architectural practices?
3. Evaluate standards compliance — does the work comply with applicable Engineering Standards?
4. Evaluate constitutional compliance — does the work comply with constitutional requirements?
5. Identify functional risks — what could go wrong?
6. Identify missing evidence — what evidence is absent?
7. Evaluate verification quality — is the verification evidence sufficient?
8. Recommend Product Owner tests — what should the PO manually test?
9. Identify required refinements — what needs to be fixed before release?

You MUST NOT:
- Grant Product Owner Verification. That is reserved for the Product Owner.
- Grant Product Owner Acceptance. That is reserved for the Product Owner.
- Simulate test results. Only report on evidence provided.
- Approve work that has missing or insufficient evidence.

Return your review as structured JSON with the following fields:
{
  "verdict": "approved" | "conditional" | "rejected",
  "requirement_satisfaction": "satisfied" | "partially_satisfied" | "not_satisfied",
  "architecture_assessment": string,
  "standards_compliance": "compliant" | "non_compliant" | "unknown",
  "constitutional_compliance": "compliant" | "non_compliant" | "unknown",
  "functional_risks": string[],
  "missing_evidence": string[],
  "verification_quality": "sufficient" | "insufficient" | "unknown",
  "recommended_po_tests": string[],
  "required_refinements": string[],
  "summary": string
}`;

function buildReviewPrompt(pkg: ReviewPackageRequest): string {
  const lines: string[] = [];
  lines.push("# Engineering Review Package");
  lines.push("");
  lines.push("## Engineering Work Order");
  lines.push(`- Reference: ${pkg.ewoRef}`);
  lines.push(`- Title: ${pkg.ewoTitle}`);
  lines.push(`- Description: ${pkg.ewoDescription}`);
  lines.push("");
  lines.push("## Requirements");
  lines.push(pkg.requirements || "Not specified");
  lines.push("");
  lines.push("## Acceptance Criteria");
  lines.push(pkg.acceptanceCriteria || "Not specified");
  lines.push("");
  lines.push("## Completion Report");
  lines.push(pkg.completionReportSummary || "No completion report provided");
  lines.push("");
  if (pkg.filesChanged && pkg.filesChanged.length > 0) {
    lines.push("## Files Changed");
    for (const f of pkg.filesChanged) lines.push(`- ${f}`);
    lines.push("");
  }
  lines.push("## Build Evidence");
  lines.push(pkg.buildEvidence || "No build evidence provided");
  lines.push("");
  lines.push("## Test Evidence");
  lines.push(pkg.testEvidence || "No test evidence provided");
  lines.push("");
  lines.push("## Verification Evidence");
  lines.push(pkg.verificationEvidence || "No verification evidence provided");
  lines.push("");
  if (pkg.applicableStandards && pkg.applicableStandards.length > 0) {
    lines.push("## Applicable Engineering Standards");
    for (const s of pkg.applicableStandards) lines.push(`- ${s}`);
    lines.push("");
  }
  if (pkg.constitutionalRequirements && pkg.constitutionalRequirements.length > 0) {
    lines.push("## Constitutional Requirements");
    for (const c of pkg.constitutionalRequirements) lines.push(`- ${c}`);
    lines.push("");
  }
  if (pkg.knownRisks && pkg.knownRisks.length > 0) {
    lines.push("## Known Risks");
    for (const r of pkg.knownRisks) lines.push(`- ${r}`);
    lines.push("");
  }
  lines.push("Please provide your engineering review as structured JSON.");
  return lines.join("\n");
}

function parseReviewResponse(content: string, ewoRef: string): {
  verdict: string;
  requirement_satisfaction: string;
  architecture_assessment: string;
  standards_compliance: string;
  constitutional_compliance: string;
  functional_risks: string[];
  missing_evidence: string[];
  verification_quality: string;
  recommended_po_tests: string[];
  required_refinements: string[];
  summary: string;
  ewo_ref: string;
} {
  try {
    // Try to extract JSON from the response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        verdict: parsed.verdict || "conditional",
        requirement_satisfaction: parsed.requirement_satisfaction || "unknown",
        architecture_assessment: parsed.architecture_assessment || "",
        standards_compliance: parsed.standards_compliance || "unknown",
        constitutional_compliance: parsed.constitutional_compliance || "unknown",
        functional_risks: Array.isArray(parsed.functional_risks) ? parsed.functional_risks : [],
        missing_evidence: Array.isArray(parsed.missing_evidence) ? parsed.missing_evidence : [],
        verification_quality: parsed.verification_quality || "unknown",
        recommended_po_tests: Array.isArray(parsed.recommended_po_tests) ? parsed.recommended_po_tests : [],
        required_refinements: Array.isArray(parsed.required_refinements) ? parsed.required_refinements : [],
        summary: parsed.summary || content.slice(0, 500),
        ewo_ref: ewoRef,
      };
    }
  } catch {
    // Fall through to default
  }

  return {
    verdict: "conditional",
    requirement_satisfaction: "unknown",
    architecture_assessment: "",
    standards_compliance: "unknown",
    constitutional_compliance: "unknown",
    functional_risks: [],
    missing_evidence: ["Review response could not be parsed"],
    verification_quality: "unknown",
    recommended_po_tests: [],
    required_refinements: [],
    summary: content.slice(0, 500),
    ewo_ref: ewoRef,
  };
}
