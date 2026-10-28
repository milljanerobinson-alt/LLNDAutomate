import { createClient } from "jsr:@supabase/supabase-js@2";
import { getOrganisationEmailProfile } from "../_shared/organisation-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const DOMAIN_LABELS: Record<string, string> = {
  reading: "Reading",
  writing: "Writing",
  numeracy: "Numeracy",
  oral: "Oral Communication",
  oral_communication: "Oral Communication",
  learning: "Learning",
  digital: "Digital Literacy",
};

const DEFAULT_MIN_LEVEL = 2;

function gapSeverity(gap: number): "none" | "minor" | "significant" {
  if (gap <= 0) return "none";
  if (gap === 1) return "minor";
  return "significant";
}

function computeRecommendation(
  llnAcsfOutcomes: Record<string, number> | null,
  digitalScore: number | null,
  requirements: { domain: string; minimum_acsf_level: number }[],
): {
  recommendation: "suitable" | "suitable_with_support" | "not_yet_suitable";
  reasons: string[];
  riskFlags: { domain: string; studentLevel: number; requiredLevel: number; gap: number }[];
} {
  const reasons: string[] = [];
  const riskFlags: { domain: string; studentLevel: number; requiredLevel: number; gap: number }[] = [];
  let llnRecommendation: "suitable" | "suitable_with_support" | "not_yet_suitable" = "suitable";
  let digitalRecommendation: "suitable" | "suitable_with_support" | "not_yet_suitable" = "suitable";

  if (llnAcsfOutcomes && Object.keys(llnAcsfOutcomes).length > 0) {
    let minorGaps = 0;
    let significantGaps = 0;

    for (const [domain, studentLevel] of Object.entries(llnAcsfOutcomes)) {
      const req = requirements.find(
        (r) =>
          r.domain.toLowerCase() === domain.toLowerCase() ||
          r.domain.toLowerCase().includes(domain.toLowerCase()),
      );
      const requiredLevel = req?.minimum_acsf_level ?? DEFAULT_MIN_LEVEL;
      const gap = requiredLevel - studentLevel;

      if (gap > 0) {
        const severity = gapSeverity(gap);
        riskFlags.push({ domain, studentLevel, requiredLevel, gap });
        const label = DOMAIN_LABELS[domain.toLowerCase()] || domain;
        if (severity === "minor") {
          minorGaps++;
          reasons.push(`${label}: ACSF Level ${studentLevel} (required ${requiredLevel}) — minor gap`);
        } else {
          significantGaps++;
          reasons.push(`${label}: ACSF Level ${studentLevel} (required ${requiredLevel}) — significant gap`);
        }
      }
    }

    if (significantGaps >= 2 || (significantGaps >= 1 && minorGaps >= 1)) {
      llnRecommendation = "not_yet_suitable";
    } else if (significantGaps === 1 || minorGaps >= 2) {
      llnRecommendation = "suitable_with_support";
    } else if (minorGaps === 1) {
      llnRecommendation = "suitable_with_support";
    }
  }

  if (digitalScore !== null) {
    if (digitalScore < 50) {
      digitalRecommendation = "not_yet_suitable";
      reasons.push(`Digital literacy score ${digitalScore}% is below the minimum threshold (50%)`);
    } else if (digitalScore < 70) {
      digitalRecommendation = "suitable_with_support";
      reasons.push(`Digital literacy score ${digitalScore}% indicates some support may be beneficial`);
    }
  }

  const priority = ["not_yet_suitable", "suitable_with_support", "suitable"];
  const worstIdx = Math.min(
    priority.indexOf(llnRecommendation),
    priority.indexOf(digitalRecommendation),
  );
  const recommendation = priority[worstIdx] as "suitable" | "suitable_with_support" | "not_yet_suitable";

  if (recommendation === "suitable" && reasons.length === 0) {
    reasons.push("All assessed domains meet or exceed qualification requirements");
  }

  return { recommendation, reasons, riskFlags };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { invitation_id, token } = body as { invitation_id?: string; token?: string };

    if (!invitation_id || !token) {
      return new Response(
        JSON.stringify({ error: "invitation_id and token are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: inv, error: invErr } = await supabase
      .from("assessment_invitations")
      .select(`*, qualification:qualifications(id, code, name, axcelerate_course_id)`)
      .eq("id", invitation_id)
      .maybeSingle();

    if (invErr || !inv) {
      return new Response(
        JSON.stringify({ error: "Invitation not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const validTokens = [inv.unique_token, inv.lln_token, inv.digital_token].filter(Boolean);
    if (!validTokens.includes(token)) {
      return new Response(
        JSON.stringify({ error: "Invalid token for this invitation" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (inv.status !== "completed") {
      return new Response(
        JSON.stringify({ message: "Assessment not yet fully complete — no action taken" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (inv.course_recommendation) {
      return new Response(
        JSON.stringify({ message: "Completion already processed", recommendation: inv.course_recommendation }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Load ACSF requirements
    let requirements: { domain: string; minimum_acsf_level: number }[] = [];
    if (inv.qualification_id) {
      const { data: reqs } = await supabase
        .from("qualification_lln_requirements")
        .select("domain, minimum_acsf_level")
        .eq("qualification_id", inv.qualification_id);
      requirements = reqs || [];

      if (requirements.length === 0) {
        const { data: libEntry } = await supabase
          .from("qualification_mapping_library")
          .select("reading_level, writing_level, numeracy_level, oral_comm_level, learning_level, digital_level")
          .eq("id", inv.qualification?.axcelerate_course_id ? inv.qualification.axcelerate_course_id : null)
          .maybeSingle();

        if (libEntry) {
          const domainMap: Record<string, number | undefined> = {
            reading: libEntry.reading_level,
            writing: libEntry.writing_level,
            numeracy: libEntry.numeracy_level,
            oral: libEntry.oral_comm_level,
            learning: libEntry.learning_level,
            digital: libEntry.digital_level,
          };
          requirements = Object.entries(domainMap)
            .filter(([, v]) => v != null)
            .map(([domain, minimum_acsf_level]) => ({ domain, minimum_acsf_level: minimum_acsf_level! }));
        }
      }
    }

    const { recommendation, reasons, riskFlags } = computeRecommendation(
      inv.lln_acsf_outcomes as Record<string, number> | null,
      inv.digital_score as number | null,
      requirements,
    );

    await supabase
      .from("assessment_invitations")
      .update({ course_recommendation: recommendation, recommendation_reasons: reasons })
      .eq("id", invitation_id);

    // Update student status
    if (inv.student_id) {
      const studentStatus = recommendation === "suitable" ? "digital_complete"
        : recommendation === "suitable_with_support" ? "support_generated"
        : "digital_complete";
      await supabase.from("students")
        .update({ current_status: studentStatus })
        .eq("id", inv.student_id);
      await supabase.from("student_lifecycle_events").insert({
        student_id: inv.student_id,
        invitation_id,
        event_type: "assessment_analysis_complete",
        from_status: "digital_complete",
        to_status: studentStatus,
        actor: "system",
        note: `Assessment complete — ${recommendation.replace(/_/g, " ")}`,
        event_data: { recommendation, reasons },
      });
    }

    await supabase.from("audit_trail").insert({
      invitation_id,
      event_type: "assessment.analysis_complete",
      category: "assessment_results",
      severity: recommendation === "not_yet_suitable" ? "warning" : "info",
      description: `Assessment analysis complete — ${recommendation.replace(/_/g, " ")} — ${inv.candidate_name}`,
      source: "system",
      actor: "system",
      event_data: { recommendation, reasons, risk_flags: riskFlags },
      timestamp: new Date().toISOString(),
    });

    // Queue aXcelerate write-backs
    await supabase.from("axcelerate_writeback_queue").upsert(
      {
        invitation_id,
        event_type: "assessment_completed",
        status: "pending",
        idempotency_key: `${invitation_id}:assessment_completed`,
        extra_data: { recommendation, reasons },
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );

    if (recommendation === "not_yet_suitable") {
      await supabase.from("axcelerate_writeback_queue").upsert(
        {
          invitation_id,
          event_type: "intervention_required",
          status: "pending",
          idempotency_key: `${invitation_id}:intervention_required`,
          extra_data: { trigger_reason: reasons.join("; ") },
        },
        { onConflict: "idempotency_key", ignoreDuplicates: true },
      );
    }

    // Admin notification email
    // Issue #40: the candidate's own RTO's branding and contact address.
    const [organisationProfile, { data: settingsRows }] = await Promise.all([
      getOrganisationEmailProfile(inv.organisation_id, supabase),
      supabase.from("settings").select("key, value").in("key", ["RESEND_API_KEY"]),
    ]);
    const settings: Record<string, any> = {};
    (settingsRows || []).forEach((s: any) => { settings[s.key] = s.value; });

    const orgName: string = organisationProfile.branding.name || "LLND Automate";
    const adminEmail: string = organisationProfile.branding.contact_email || "";
    const RESEND_API_KEY: string = Deno.env.get("RESEND_API_KEY") || (typeof settings["RESEND_API_KEY"] === "string" ? settings["RESEND_API_KEY"] : "");
    const portalBase = Deno.env.get("SITE_URL") || "https://app.example.com";
    const qualName = inv.qualification ? `${inv.qualification.code} ${inv.qualification.name}` : "N/A";

    const recLabels: Record<string, string> = {
      suitable: "SUITABLE — No additional support required",
      suitable_with_support: "SUITABLE WITH SUPPORT — Support plan recommended",
      not_yet_suitable: "NOT YET SUITABLE — Significant support required",
    };
    const urgency = recommendation === "not_yet_suitable";
    const subject = urgency
      ? `⚠ Action Required: ${inv.candidate_name} requires intervention — ${orgName}`
      : `Assessment Completed: ${inv.candidate_name} — ${orgName}`;
    const recBadgeColor = urgency ? "#dc2626" : recommendation === "suitable_with_support" ? "#d97706" : "#059669";

    const adminHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:${urgency ? "#dc2626" : "#1e40af"};padding:32px 40px;">
      <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">${orgName}</h1>
      <p style="margin:8px 0 0;color:${urgency ? "#fecaca" : "#bfdbfe"};font-size:14px;">${urgency ? "Intervention Required" : "Assessment Completed"}</p>
    </div>
    <div style="padding:32px 40px;">
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:20px;">${urgency ? "⚠ Intervention Required" : "Assessment Complete"}</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <tr><td style="padding:8px 12px;background:#f8fafc;font-size:14px;font-weight:600;color:#374151;width:130px;">Learner</td><td style="padding:8px 12px;font-size:14px;color:#475569;">${inv.candidate_name} &lt;${inv.candidate_email}&gt;</td></tr>
        <tr><td style="padding:8px 12px;background:#f8fafc;font-size:14px;font-weight:600;color:#374151;">Qualification</td><td style="padding:8px 12px;font-size:14px;color:#475569;">${qualName}</td></tr>
        <tr><td style="padding:8px 12px;background:#f8fafc;font-size:14px;font-weight:600;color:#374151;">Outcome</td><td style="padding:8px 12px;font-size:14px;font-weight:700;color:${recBadgeColor};">${recLabels[recommendation] || recommendation}</td></tr>
      </table>
      ${reasons.length > 0 ? `<div style="background:#f8fafc;border-radius:8px;padding:16px;margin-bottom:20px;"><p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#374151;">Key Findings</p><ul style="margin:0;padding-left:20px;">${reasons.map((r) => `<li style="font-size:13px;color:#475569;margin-bottom:4px;">${r}</li>`).join("")}</ul></div>` : ""}
      <a href="${portalBase}/#/app?page=results" style="display:inline-block;background:${urgency ? "#dc2626" : "#1e40af"};color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;">View Results</a>
    </div>
    <div style="padding:20px 40px;background:#f8fafc;border-top:1px solid #e2e8f0;"><p style="margin:0;color:#94a3b8;font-size:12px;">Automated notification from ${orgName}.</p></div>
  </div>
</body></html>`;

    let adminEmailStatus = "pending";
    if (RESEND_API_KEY && adminEmail) {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${orgName} <onboarding@resend.dev>`,
          to: [adminEmail],
          subject,
          html: adminHtml,
        }),
      });
      adminEmailStatus = emailRes.ok ? "sent" : "failed";
    }

    await supabase.from("notifications").insert({
      invitation_id,
      type: "completed",
      recipient_email: adminEmail || "admin",
      recipient_name: `${orgName} Team`,
      subject,
      body: adminHtml,
      status: adminEmailStatus,
    });

    await supabase.from("email_queue").upsert(
      {
        invitation_id,
        email_type: "completion_admin",
        recipient_email: adminEmail || "admin",
        recipient_name: `${orgName} Team`,
        scheduled_at: new Date().toISOString(),
        status: adminEmailStatus === "sent" ? "sent" : "pending",
        idempotency_key: `${invitation_id}:completion_admin`,
        sent_at: adminEmailStatus === "sent" ? new Date().toISOString() : null,
        extra_data: { recommendation, qualification_name: qualName },
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

    const backgroundWork = (async () => {
      // Dispatch aXcelerate write-back queue
      try {
        await fetch(`${supabaseUrl}/functions/v1/process-axcelerate-queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
          body: JSON.stringify({ invitation_id }),
        });
      } catch (_) {}

      // Auto-generate support plan if not already present
      try {
        const { data: existingPlan } = await supabase
          .from("support_plans")
          .select("id")
          .eq("invitation_id", invitation_id)
          .maybeSingle();

        if (!existingPlan) {
          await fetch(`${supabaseUrl}/functions/v1/generate-support-plan`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
            body: JSON.stringify({ invitation_id, auto_generated: true }),
          });
        }
      } catch (_) {}

      // Upload assessment reports to aXcelerate Portfolio if contact ID is set
      // Re-read the invitation to get the updated axcelerate_contact_id (may have been set by write-back)
      try {
        const { data: updatedInv } = await supabase
          .from("assessment_invitations")
          .select("axcelerate_contact_id, lln_status, digital_status")
          .eq("id", invitation_id)
          .maybeSingle();

        if (updatedInv?.axcelerate_contact_id) {
          const uploadTasks: Promise<any>[] = [];

          if (updatedInv.lln_status === "completed") {
            uploadTasks.push(
              fetch(`${supabaseUrl}/functions/v1/upload-axcelerate-portfolio`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
                body: JSON.stringify({ invitation_id, assessment_type: "lln" }),
              }).catch(() => {}),
            );
          }

          if (updatedInv.digital_status === "completed") {
            uploadTasks.push(
              fetch(`${supabaseUrl}/functions/v1/upload-axcelerate-portfolio`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
                body: JSON.stringify({ invitation_id, assessment_type: "digital" }),
              }).catch(() => {}),
            );
          }

          if (uploadTasks.length > 0) await Promise.allSettled(uploadTasks);
        }
      } catch (_) {}
    })();

    try {
      if (typeof (globalThis as any).EdgeRuntime !== "undefined") {
        (globalThis as any).EdgeRuntime.waitUntil(backgroundWork);
      } else {
        await backgroundWork;
      }
    } catch (_) {}

    await supabase.from("audit_trail").insert({
      invitation_id,
      event_type: "assessment.completion_chain_complete",
      category: "assessment_results",
      severity: "info",
      description: `Completion chain triggered — write-back queued, admin notified, support plan requested`,
      source: "system",
      actor: "system",
      event_data: {
        recommendation,
        admin_email_status: adminEmailStatus,
        axcelerate_queued: true,
        intervention_queued: recommendation === "not_yet_suitable",
      },
      timestamp: new Date().toISOString(),
    });

    return new Response(
      JSON.stringify({
        success: true,
        recommendation,
        reasons,
        admin_email_status: adminEmailStatus,
        axcelerate_write_back_queued: true,
        support_plan_requested: true,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
