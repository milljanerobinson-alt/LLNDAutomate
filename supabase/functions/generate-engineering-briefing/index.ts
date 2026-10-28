// @ts-nocheck — updated for Phase X scheduling support
import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";
import { generate, loadAIConfig } from "../_shared/ai-service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

async function verifyAuth(req: Request): Promise<{ svc: ReturnType<typeof createClient>; userId: string; isCron: boolean } | null> {
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Cron secret auth (for scheduled-briefing-runner calls)
  const cronHeader = req.headers.get("X-Cron-Secret");
  if (cronHeader) {
    const { data: setting } = await svc.from("settings").select("value").eq("key", "cron_secret").maybeSingle();
    const storedSecret = setting?.value ? String(setting.value).replace(/^"|"$/g, '') : null;
    if (storedSecret && cronHeader === storedSecret) {
      return { svc, userId: "cron", isCron: true };
    }
    return null;
  }

  // JWT user auth
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.replace("Bearer ", "");
  const anonClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: { user }, error } = await anonClient.auth.getUser(token);
  if (error || !user) return null;
  const { data: profile } = await svc.from("profiles").select("role").eq("id", user.id).maybeSingle();
  // Issue #45: operator status (grant + MFA) is enforced by requirePlatformOperator() in the request handler; the legacy profiles.role check is retired.
  if (!profile) return null;
  return { svc, userId: user.id, isCron: false };
}

// ─── Compute health scores deterministically ──────────────────────────────────

interface HealthData {
  engineering_health: number;
  platform_confidence: number;
  testing_health: number;
  documentation_health: number;
  roadmap_health: number;
  architecture_health: number;
  release_readiness: number;
  audit_readiness: number;
  engineering_debt: number;
  critical_issues: number;
  features_live: number;
  features_total: number;
  testing_passed: number;
  testing_total: number;
  docs_complete: number;
  docs_total: number;
  backlog_open: number;
  backlog_blocked: number;
  compliance_critical_untested: number;
}

interface EngineeringSummary {
  current_phase: string;
  current_release: string;
  active_rc_status: string;
  goals_active: number;
  goals_complete: number;
  epics_active: number;
  epics_complete: number;
  avg_goal_progress: number;
  avg_epic_progress: number;
  recent_decisions: number;
}

async function computeHealth(svc: ReturnType<typeof createClient>): Promise<{
  health: HealthData;
  summary: EngineeringSummary;
  rawContext: string;
  engineeringPhase: string;
  platformVersion: string;
}> {
  const [features, goals, epics, backlog, releases, phases, decisions, roadmap, docs] = await Promise.all([
    svc.from("ecc_product_features").select("feature_id,name,lifecycle_stage,testing_status,documentation_status,operational_risk,compliance_critical,audit_critical,priority,category"),
    svc.from("ecc_goals").select("title,status,priority,progress_pct,target_date").order("position"),
    svc.from("ecc_epics").select("title,status,priority,progress_pct").order("position"),
    svc.from("ecc_backlog_items").select("title,priority,status,item_type,risk,testing_status,documentation_complete").order("created_at", { ascending: false }).limit(50),
    svc.from("ecc_release_candidates").select("rc_number,phase_name,status,is_active,manual_testing_status,regression_testing_status,deployment_status,release_type,created_at").order("created_at", { ascending: false }).limit(10),
    svc.from("ecc_phases").select("name,status,target_version").order("sort_order").limit(5),
    svc.from("ecc_decisions").select("title,status,decision_date,category").order("decision_date", { ascending: false }).limit(10),
    svc.from("ecc_roadmap_items").select("title,status,priority").order("position").limit(20),
    svc.from("ecc_documentation").select("title,doc_type,status,version").order("updated_at", { ascending: false }).limit(30),
  ]);

  const f = features.data ?? [];
  const g = goals.data ?? [];
  const e = epics.data ?? [];
  const b = backlog.data ?? [];
  const r = releases.data ?? [];
  const p = phases.data ?? [];
  const d = decisions.data ?? [];
  const rm = roadmap.data ?? [];

  // Feature health
  const fTotal = f.length;
  const fLive = f.filter((x: Record<string, unknown>) => ["live", "production_ready"].includes(x.lifecycle_stage as string)).length;
  const fTested = f.filter((x: Record<string, unknown>) => x.testing_status === "passed").length;
  const fTestedTotal = f.filter((x: Record<string, unknown>) => x.testing_status !== null && x.testing_status !== "not_tested").length;
  const fDocsComplete = f.filter((x: Record<string, unknown>) => x.documentation_status === "complete").length;
  const fCriticalUntested = f.filter((x: Record<string, unknown>) => x.compliance_critical && x.testing_status !== "passed").length;
  const fCriticalRisk = f.filter((x: Record<string, unknown>) => x.operational_risk === "critical").length;

  // Backlog health
  const bBlocked = b.filter((x: Record<string, unknown>) => x.status === "blocked").length;
  const bOpen = b.filter((x: Record<string, unknown>) => ["open", "in_progress"].includes(x.status as string)).length;

  // Release health
  const activeRC = r.find((x: Record<string, unknown>) => x.is_active);
  const currentRelease = activeRC ? (activeRC.rc_number as string) : (r[0]?.rc_number as string ?? "None");
  const currentPhase = p.find((x: Record<string, unknown>) => x.status === "active")?.name as string
    ?? p[0]?.name as string ?? "No active phase";

  // Goals/epics
  const gActive = g.filter((x: Record<string, unknown>) => x.status === "active").length;
  const gComplete = g.filter((x: Record<string, unknown>) => x.status === "completed").length;
  const eActive = e.filter((x: Record<string, unknown>) => x.status === "active").length;
  const eComplete = e.filter((x: Record<string, unknown>) => x.status === "completed").length;
  const avgGoalPct = g.length > 0 ? Math.round(g.reduce((s: number, x: Record<string, unknown>) => s + ((x.progress_pct as number) || 0), 0) / g.length) : 0;
  const avgEpicPct = e.length > 0 ? Math.round(e.reduce((s: number, x: Record<string, unknown>) => s + ((x.progress_pct as number) || 0), 0) / e.length) : 0;

  // Score computations (0-100)
  const platformConfidence   = fTotal > 0 ? Math.round((fLive / fTotal) * 100) : 0;
  const testingHealth        = fTestedTotal > 0 ? Math.round((fTested / fTestedTotal) * 100) : 0;
  const documentationHealth  = fTotal > 0 ? Math.round((fDocsComplete / fTotal) * 100) : 0;
  const roadmapHealth        = g.length > 0 ? Math.round((avgGoalPct + avgEpicPct) / 2) : 50;
  const archHealth           = fCriticalRisk > 0 ? Math.max(40, 95 - fCriticalRisk * 10) : 95;
  const engineeringDebt      = fTotal > 0 ? Math.round(((fTotal - fLive) / fTotal) * 100) : 0;
  const auditReadiness       = fCriticalUntested === 0 ? 92 : Math.max(40, 90 - fCriticalUntested * 15);
  const releaseReadiness     = activeRC
    ? (activeRC.regression_testing_status === "passed" && activeRC.manual_testing_status === "passed" ? 90
      : activeRC.regression_testing_status === "passed" ? 65
      : activeRC.manual_testing_status === "passed" ? 55 : 35)
    : 50;
  const engineeringHealth    = Math.round((platformConfidence + testingHealth + documentationHealth + roadmapHealth) / 4);
  const criticalIssues       = (bBlocked > 2 ? 1 : 0) + (fCriticalRisk > 0 ? 1 : 0) + (fCriticalUntested > 3 ? 1 : 0);

  const health: HealthData = {
    engineering_health: engineeringHealth,
    platform_confidence: platformConfidence,
    testing_health: testingHealth,
    documentation_health: documentationHealth,
    roadmap_health: roadmapHealth,
    architecture_health: archHealth,
    release_readiness: releaseReadiness,
    audit_readiness: auditReadiness,
    engineering_debt: engineeringDebt,
    critical_issues: criticalIssues,
    features_live: fLive,
    features_total: fTotal,
    testing_passed: fTested,
    testing_total: fTestedTotal,
    docs_complete: fDocsComplete,
    docs_total: fTotal,
    backlog_open: bOpen,
    backlog_blocked: bBlocked,
    compliance_critical_untested: fCriticalUntested,
  };

  const summary: EngineeringSummary = {
    current_phase: currentPhase,
    current_release: currentRelease,
    active_rc_status: activeRC ? (activeRC.status as string) : "none",
    goals_active: gActive,
    goals_complete: gComplete,
    epics_active: eActive,
    epics_complete: eComplete,
    avg_goal_progress: avgGoalPct,
    avg_epic_progress: avgEpicPct,
    recent_decisions: d.filter((x: Record<string, unknown>) => {
      const date = new Date(x.decision_date as string);
      return (Date.now() - date.getTime()) < 7 * 24 * 60 * 60 * 1000;
    }).length,
  };

  // Build compact context string for AI
  const featureList = f.slice(0, 20).map((x: Record<string, unknown>) =>
    `${x.feature_id}: ${x.name} [${x.lifecycle_stage}] test:${x.testing_status} docs:${x.documentation_status}${x.compliance_critical ? " COMPLIANCE-CRITICAL" : ""}`
  ).join("\n");

  const goalList = g.map((x: Record<string, unknown>) =>
    `- ${x.title} [${x.status}] ${x.progress_pct}% progress`
  ).join("\n");

  const epicList = e.map((x: Record<string, unknown>) =>
    `- ${x.title} [${x.status}] ${x.progress_pct}% progress`
  ).join("\n");

  const backlogHighPriority = b.filter((x: Record<string, unknown>) => ["critical", "high"].includes(x.priority as string)).slice(0, 10).map((x: Record<string, unknown>) =>
    `- [${x.priority}] ${x.title} (${x.status})${x.status === "blocked" ? " ⚠ BLOCKED" : ""}`
  ).join("\n");

  const rcList = r.slice(0, 5).map((x: Record<string, unknown>) =>
    `- ${x.rc_number} [${x.status}]${x.is_active ? " ★ACTIVE" : ""} manual:${x.manual_testing_status} regression:${x.regression_testing_status}`
  ).join("\n");

  const roadmapList = rm.slice(0, 10).map((x: Record<string, unknown>) =>
    `- ${x.title} [${x.status}] ${x.priority}`
  ).join("\n");

  const docList = (docs.data ?? []).filter((x: Record<string, unknown>) => x.status !== "draft").slice(0, 10).map((x: Record<string, unknown>) =>
    `- ${x.title} (${x.doc_type}) v${x.version} [${x.status}]`
  ).join("\n");

  const rawContext = `
## Computed Health Scores
Engineering Health: ${engineeringHealth}%
Platform Confidence: ${platformConfidence}% (${fLive}/${fTotal} features live/prod-ready)
Testing Health: ${testingHealth}% (${fTested}/${fTestedTotal} features tested)
Documentation Health: ${documentationHealth}% (${fDocsComplete}/${fTotal} features documented)
Roadmap Health: ${roadmapHealth}% (avg goal:${avgGoalPct}% epic:${avgEpicPct}%)
Architecture Health: ${archHealth}% (${fCriticalRisk} critical-risk features)
Release Readiness: ${releaseReadiness}%
Audit Readiness: ${auditReadiness}% (${fCriticalUntested} compliance-critical features untested)
Engineering Debt: ${engineeringDebt}% of features not yet live
Critical Issues: ${criticalIssues}
Blocked Backlog Items: ${bBlocked}

## Current Engineering Programme
Current Phase: ${currentPhase}
Active Release: ${currentRelease} [${activeRC?.status ?? "none"}]
Goals: ${gActive} active, ${gComplete} complete, avg ${avgGoalPct}% progress
Epics: ${eActive} active, ${eComplete} complete, avg ${avgEpicPct}% progress
Recent Decisions (7d): ${summary.recent_decisions}

## Features (first 20)
${featureList || "None."}

## Active Goals
${goalList || "None."}

## Active Epics
${epicList || "None."}

## High-Priority Backlog
${backlogHighPriority || "None."}

## Release Candidates
${rcList || "None."}

## Roadmap
${roadmapList || "None."}

## Documentation
${docList || "None."}
`.trim();

  return { health, summary, rawContext, engineeringPhase: currentPhase, platformVersion: currentRelease };
}

// ─── Parse structured block ───────────────────────────────────────────────────

function parseJsonBlock(raw: string, start: string, end: string): Record<string, unknown> | null {
  const si = raw.lastIndexOf(start);
  if (si !== -1) {
    const ei = raw.lastIndexOf(end);
    const str = raw.slice(si + start.length, ei > si ? ei : undefined).trim()
      .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { return JSON.parse(str); } catch { /* fall through */ }
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch { /* give up */ }
  }
  return null;
}

// ─── Main handler ──────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  // Issue #45: platform operators with MFA only. Scheduled runs keep their own
  // X-Cron-Secret validation below; service-role calls also pass.
  if (!req.headers.get("X-Cron-Secret")) {
    const operatorCheck = await requirePlatformOperator(req.headers.get("Authorization"), { allowServiceRole: true });
    if (!operatorCheck.ok) return operatorDeniedResponse(operatorCheck, corsHeaders);
  }

  try {
    const authResult = await verifyAuth(req);
    if (!authResult) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const { svc, userId, isCron } = authResult;

    const body = await req.json().catch(() => ({})) as {
      force_refresh?: boolean;
      generate_new?: boolean;
      trigger_type?: string;
      template_id?: string;
      schedule_id?: string;
      scheduled_for?: string;
    };
    const shouldGenerate = body.generate_new === true || body.force_refresh === true || isCron;
    const triggerType = body.trigger_type ?? (isCron ? "scheduled" : (body.generate_new === true ? "manual" : "manual"));

    // If not explicitly generating, return latest stored briefing without AI
    if (!shouldGenerate) {
      const { data: latest } = await svc
        .from("ecc_ai_briefings")
        .select("id,briefing_data,health_data,engineering_summary,created_at,briefing_ref,ai_model,token_input,token_output,generation_duration_ms,estimated_cost_usd,engineering_phase,platform_version,template_id,trigger_type,scheduled_for")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: inboxItems } = await svc
        .from("ecc_ai_inbox")
        .select("*")
        .in("status", ["pending"])
        .or(`snoozed_until.is.null,snoozed_until.lt.${new Date().toISOString()}`)
        .order("created_at", { ascending: false })
        .limit(20);

      return new Response(JSON.stringify({
        briefing: latest?.briefing_data ?? null,
        health: latest?.health_data ?? null,
        engineering_summary: latest?.engineering_summary ?? null,
        inbox_items: inboxItems ?? [],
        cached: true,
        generated_at: latest?.created_at ?? null,
        briefing_ref: latest?.briefing_ref ?? null,
        briefing_id: latest?.id ?? null,
        ai_model: latest?.ai_model ?? null,
        token_input: latest?.token_input ?? null,
        token_output: latest?.token_output ?? null,
        generation_duration_ms: latest?.generation_duration_ms ?? null,
        estimated_cost_usd: latest?.estimated_cost_usd ?? null,
        engineering_phase: latest?.engineering_phase ?? null,
        platform_version: latest?.platform_version ?? null,
        template_id: latest?.template_id ?? null,
        trigger_type: latest?.trigger_type ?? null,
        scheduled_for: latest?.scheduled_for ?? null,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Generate new briefing
    const aiCfg = await loadAIConfig(svc);
    if (!aiCfg) {
      return new Response(JSON.stringify({ error: "NO_API_KEY" }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { health, summary, rawContext, engineeringPhase, platformVersion } = await computeHealth(svc);

    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

    // Load template system prompt (falls back to default if not found)
    let systemPrompt = "";
    let resolvedTemplateId: string | null = body.template_id ?? null;
    if (body.template_id) {
      const { data: tmpl } = await svc.from("ecc_briefing_templates").select("system_prompt_template,id").eq("id", body.template_id).eq("is_active", true).maybeSingle();
      if (tmpl) systemPrompt = (tmpl.system_prompt_template as string).replace(/\{\{time_of_day\}\}/g, `Good ${timeOfDay}`).replace(/\{\{timezone\}\}/g, "Australia/Sydney");
    }
    if (!systemPrompt) {
      const { data: defaultTmpl } = await svc.from("ecc_briefing_templates").select("system_prompt_template,id").eq("is_default", true).eq("is_active", true).maybeSingle();
      if (defaultTmpl) {
        systemPrompt = (defaultTmpl.system_prompt_template as string).replace(/\{\{time_of_day\}\}/g, `Good ${timeOfDay}`).replace(/\{\{timezone\}\}/g, "Australia/Sydney");
        if (!resolvedTemplateId) resolvedTemplateId = defaultTmpl.id as string;
      }
    }
    // Hard-coded fallback prompt
    if (!systemPrompt) systemPrompt = `You are the Engineering AI Technical Director for LLND Automate. Analyse the engineering programme state and output a briefing as JSON between %%BRIEFING%% and %%END_BRIEFING%% markers with keys: greeting, primary_recommendation, next_action, inbox_items.`;

    const userMessage = `Please analyse this Engineering Programme state and generate the briefing.\n\n${rawContext}`;

    const generationStart = Date.now();
    const aiResponse = await generate(svc, {
      feature: "engineering-briefing",
      systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      userId: userId === "cron" ? undefined : userId,
    });
    const generationDurationMs = Date.now() - generationStart;

    const parsed = parseJsonBlock(aiResponse.content, "%%BRIEFING%%", "%%END_BRIEFING%%");
    if (!parsed) {
      return new Response(JSON.stringify({ error: "Failed to parse briefing from AI response" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Estimate cost (approximate Claude pricing: ~$3/M input, ~$15/M output)
    const tokenIn  = (aiResponse as Record<string, unknown>).input_tokens  as number | undefined;
    const tokenOut = (aiResponse as Record<string, unknown>).output_tokens as number | undefined;
    const estimatedCost = tokenIn && tokenOut
      ? parseFloat(((tokenIn / 1_000_000) * 3 + (tokenOut / 1_000_000) * 15).toFixed(6))
      : null;

    // Store briefing as permanent artefact
    const now = new Date().toISOString();
    const scheduledFor = body.scheduled_for
      ?? ((triggerType === "scheduled" || triggerType === "startup_catchup") ? new Date().toISOString().split("T")[0] : null);

    const { data: briefingRow } = await svc.from("ecc_ai_briefings").insert({
      briefing_data: parsed,
      health_data: health,
      engineering_summary: summary,
      generated_by: userId === "cron" ? null : userId,
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      ai_model: (aiResponse as Record<string, unknown>).model as string ?? null,
      token_input: tokenIn ?? null,
      token_output: tokenOut ?? null,
      generation_duration_ms: generationDurationMs,
      estimated_cost_usd: estimatedCost,
      engineering_phase: engineeringPhase,
      platform_version: platformVersion,
      template_id: resolvedTemplateId,
      trigger_type: triggerType,
      scheduled_for: scheduledFor,
      schedule_id: body.schedule_id ?? null,
    }).select("id, briefing_ref").single();

    // Update schedule config run stats
    if (body.schedule_id && briefingRow?.id) {
      await svc.from("ecc_briefing_schedule_config")
        .update({ last_run_at: now, last_run_briefing_id: briefingRow.id, updated_at: now })
        .eq("id", body.schedule_id);
    }

    // Populate inbox items (de-dupe by title)
    const inboxItems = Array.isArray(parsed.inbox_items) ? parsed.inbox_items as Record<string, unknown>[] : [];
    const newInboxRows: Record<string, unknown>[] = [];

    for (const item of inboxItems) {
      const title = item.title as string;
      if (!title) continue;
      const { data: existing } = await svc
        .from("ecc_ai_inbox")
        .select("id")
        .eq("title", title)
        .in("status", ["pending"])
        .maybeSingle();

      if (!existing) {
        newInboxRows.push({
          type: item.type ?? "recommendation",
          priority: item.priority ?? "medium",
          title,
          description: item.description ?? null,
          impact: item.impact ?? null,
          confidence: typeof item.confidence === "number" ? item.confidence : null,
          estimated_effort: item.estimated_effort ?? null,
          reasoning: item.reasoning ?? null,
          briefing_id: briefingRow?.id ?? null,
          status: "pending",
        });
      }
    }

    let allInboxItems: Record<string, unknown>[] = [];
    if (newInboxRows.length > 0) {
      const { data: inserted } = await svc.from("ecc_ai_inbox").insert(newInboxRows).select("*");
      allInboxItems = inserted ?? [];
    }

    const { data: existingPending } = await svc
      .from("ecc_ai_inbox")
      .select("*")
      .in("status", ["pending"])
      .not("id", "in", `(${allInboxItems.map(r => `'${r.id}'`).join(",") || "'00000000-0000-0000-0000-000000000000'"})`)
      .order("created_at", { ascending: false })
      .limit(20);

    const combined = [...allInboxItems, ...(existingPending ?? [])];

    return new Response(JSON.stringify({
      briefing: parsed,
      health,
      engineering_summary: summary,
      inbox_items: combined,
      cached: false,
      generated_at: now,
      briefing_ref: briefingRow?.briefing_ref ?? null,
      briefing_id: briefingRow?.id ?? null,
      ai_model: (aiResponse as Record<string, unknown>).model as string ?? null,
      token_input: tokenIn ?? null,
      token_output: tokenOut ?? null,
      generation_duration_ms: generationDurationMs,
      estimated_cost_usd: estimatedCost,
      engineering_phase: engineeringPhase,
      platform_version: platformVersion,
      template_id: resolvedTemplateId,
      trigger_type: triggerType,
      scheduled_for: scheduledFor,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("generate-engineering-briefing error:", err);
    const isNoKey = err instanceof Error && err.message.startsWith("NO_API_KEY");
    return new Response(JSON.stringify({ error: isNoKey ? "NO_API_KEY" : (err instanceof Error ? err.message : "Internal error") }), {
      status: isNoKey ? 422 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
