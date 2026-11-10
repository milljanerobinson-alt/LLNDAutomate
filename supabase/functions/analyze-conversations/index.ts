import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Conversation {
  id: string;
  title: string;
  context_type: string;
  context_id: string | null;
  summary: string | null;
  status: string;
  completed_at: string | null;
  auto_completed: boolean;
  migration_notes: string | null;
  created_at: string;
  updated_at: string;
}

interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface AnalysisResult {
  conversation_id: string;
  title: string;
  original_title: string;
  action: "auto_complete" | "flag_for_review" | "leave_active";
  completion_reason: string | null;
  improved_title: string | null;
  artefact_links: ArtefactLink[];
  confidence: number;
  notes: string;
}

interface ArtefactLink {
  artefact_type: string;
  artefact_id: string | null;
  artefact_ref: string | null;
  artefact_title: string | null;
  link_confidence: number;
}

// ─── Evidence Collection ──────────────────────────────────────────────────────

async function collectEngineeringEvidence(supabase: ReturnType<typeof createClient>) {
  const [
    audits, features, releases, testPlans, decisions, phases, epics, goals, guardian,
  ] = await Promise.all([
    supabase.from("ecc_audits").select("id, name, status, created_at, audit_type").order("created_at", { ascending: false }).limit(50),
    supabase.from("ecc_product_features").select("id, name, status, phase, created_at, source_conversation_id").order("created_at", { ascending: false }).limit(100),
    supabase.from("ecc_release_candidates").select("id, rc_number, title, status, created_at").order("created_at", { ascending: false }).limit(20),
    supabase.from("ecc_test_plans").select("id, plan_ref, title, status, created_at").order("created_at", { ascending: false }).limit(30),
    supabase.from("ecc_decisions").select("id, decision_ref, title, status, created_at, source_conversation_id").order("created_at", { ascending: false }).limit(50),
    supabase.from("ecc_dev_phases").select("id, name, status, created_at").order("created_at", { ascending: false }).limit(20),
    supabase.from("ecc_epics").select("id, title, status, created_at, source_conversation_id").order("created_at", { ascending: false }).limit(50),
    supabase.from("ecc_goals").select("id, title, status, created_at, source_conversation_id").order("created_at", { ascending: false }).limit(30),
    supabase.from("ecc_guardian_reviews").select("id, review_ref, title, status, created_at").order("created_at", { ascending: false }).limit(20).maybeSingle().then(() =>
      supabase.from("ecc_guardian_reviews").select("id, review_ref, title, status, created_at").order("created_at", { ascending: false }).limit(20)
    ),
  ]);

  return {
    audits: audits.data ?? [],
    features: features.data ?? [],
    releases: releases.data ?? [],
    testPlans: testPlans.data ?? [],
    decisions: decisions.data ?? [],
    phases: phases.data ?? [],
    epics: epics.data ?? [],
    goals: goals.data ?? [],
    guardian: guardian.data ?? [],
  };
}

// ─── Title Quality Check ──────────────────────────────────────────────────────

const GENERIC_TITLE_PATTERNS = [
  /^new conversation$/i,
  /^untitled/i,
  /^conversation \d+$/i,
  /^chat$/i,
  /^question$/i,
  /^help$/i,
  /^test$/i,
];

function isUnclearTitle(title: string): boolean {
  return GENERIC_TITLE_PATTERNS.some((p) => p.test(title.trim())) || title.trim().length < 8;
}

// ─── Message Analysis ─────────────────────────────────────────────────────────

function extractCompletionSignals(
  messages: Message[],
  evidence: ReturnType<typeof collectEngineeringEvidence> extends Promise<infer T> ? T : never,
  conv: Conversation,
): { isComplete: boolean; confidence: number; reason: string; improvedTitle: string | null } {
  const fullText = messages.map((m) => m.content).join(" ").toLowerCase();
  const hasDecisions = messages.some((m) => m.metadata?.created_artefacts || m.metadata?.change_record_id);

  // Signals that indicate work is done
  const completionKeywords = [
    "implemented", "deployed", "released", "shipped", "completed", "done",
    "merged", "closed", "resolved", "fixed", "launched", "live",
    "migration applied", "edge function deployed", "build successful",
  ];
  const completionHits = completionKeywords.filter((k) => fullText.includes(k)).length;

  // Signals that indicate work is still ongoing
  const openSignals = [
    "todo", "need to", "will need", "should we", "what about", "how do we",
    "pending", "blocked", "waiting for", "not yet", "haven't", "still need",
    "in progress", "wip",
  ];
  const openHits = openSignals.filter((k) => fullText.includes(k)).length;

  // Check if the conversation has a linked artefact that is now complete
  let artefactComplete = false;
  if (conv.context_type === "feature" && conv.context_id) {
    const feat = evidence.features.find((f) => f.id === conv.context_id);
    if (feat && ["live", "complete", "deprecated"].includes(feat.status ?? "")) {
      artefactComplete = true;
    }
  }
  if (conv.context_type === "release" && conv.context_id) {
    const rc = evidence.releases.find((r) => r.id === conv.context_id);
    if (rc && ["released", "archived"].includes(rc.status ?? "")) {
      artefactComplete = true;
    }
  }

  // Derive a confidence score
  let confidence = 0;
  if (completionHits >= 3) confidence += 50;
  else if (completionHits >= 1) confidence += 25;
  if (hasDecisions) confidence += 20;
  if (artefactComplete) confidence += 35;
  if (openHits > 2) confidence -= 30;
  if (openHits > 5) confidence -= 20; // extra penalty

  confidence = Math.max(0, Math.min(100, confidence));

  // Only auto-complete with high confidence to avoid false positives
  const isComplete = confidence >= 70;
  const reason = artefactComplete
    ? "Linked engineering artefact has reached completion status"
    : completionHits >= 3 && openHits <= 1
    ? "Conversation contains strong completion signals with minimal open work indicators"
    : hasDecisions && completionHits >= 1
    ? "Engineering artefacts were created and completion signals present"
    : "Insufficient evidence of completion";

  // Try to infer a better title from the first substantial user message
  let improvedTitle: string | null = null;
  if (isUnclearTitle(conv.title) && messages.length > 0) {
    const firstUserMsg = messages.find((m) => m.role === "user");
    if (firstUserMsg) {
      const text = firstUserMsg.content.trim();
      if (text.length > 10 && text.length < 100) {
        // Use first sentence or up to 60 chars
        const sentence = text.split(/[.!?]/)[0].trim();
        improvedTitle = sentence.length > 5 ? sentence.slice(0, 70) : null;
      }
    }
  }

  return { isComplete, confidence, reason, improvedTitle };
}

// ─── Artefact Link Discovery ──────────────────────────────────────────────────

function discoverArtefactLinks(
  conv: Conversation,
  messages: Message[],
  evidence: ReturnType<typeof collectEngineeringEvidence> extends Promise<infer T> ? T : never,
): ArtefactLink[] {
  const links: ArtefactLink[] = [];
  const fullText = messages.map((m) => m.content).join(" ").toLowerCase();

  // Existing source_conversation_id links
  for (const feat of evidence.features) {
    if ((feat as Record<string, unknown>).source_conversation_id === conv.id) {
      links.push({ artefact_type: "feature", artefact_id: feat.id, artefact_ref: null, artefact_title: (feat as Record<string, unknown>).name as string, link_confidence: 100 });
    }
  }
  for (const dec of evidence.decisions) {
    if ((dec as Record<string, unknown>).source_conversation_id === conv.id) {
      links.push({ artefact_type: "decision", artefact_id: dec.id, artefact_ref: (dec as Record<string, unknown>).decision_ref as string, artefact_title: (dec as Record<string, unknown>).title as string, link_confidence: 100 });
    }
  }
  for (const epic of evidence.epics) {
    if ((epic as Record<string, unknown>).source_conversation_id === conv.id) {
      links.push({ artefact_type: "epic", artefact_id: epic.id, artefact_ref: null, artefact_title: (epic as Record<string, unknown>).title as string, link_confidence: 100 });
    }
  }
  for (const goal of evidence.goals) {
    if ((goal as Record<string, unknown>).source_conversation_id === conv.id) {
      links.push({ artefact_type: "goal", artefact_id: goal.id, artefact_ref: null, artefact_title: (goal as Record<string, unknown>).title as string, link_confidence: 100 });
    }
  }

  // Messages with created artefacts (ecc_ai_artefact_log)
  for (const msg of messages) {
    const artefacts = (msg.metadata?.created_artefacts ?? []) as Array<{ type: string; id: string; title: string }>;
    for (const a of artefacts) {
      if (!links.find((l) => l.artefact_id === a.id)) {
        links.push({ artefact_type: a.type, artefact_id: a.id, artefact_ref: null, artefact_title: a.title, link_confidence: 95 });
      }
    }
  }

  // Context-based linking
  if (conv.context_type !== "general" && conv.context_id) {
    const typeMap: Record<string, string> = {
      feature: "feature",
      release: "release",
      testing: "test_plan",
      architecture: "decision",
    };
    const mappedType = typeMap[conv.context_type];
    if (mappedType && !links.find((l) => l.artefact_id === conv.context_id)) {
      // Try to find the title
      let title: string | null = null;
      if (conv.context_type === "feature") {
        const f = evidence.features.find((f) => f.id === conv.context_id);
        title = f ? (f as Record<string, unknown>).name as string : null;
      } else if (conv.context_type === "release") {
        const r = evidence.releases.find((r) => r.id === conv.context_id);
        title = r ? (r as Record<string, unknown>).title as string : null;
      }
      links.push({ artefact_type: mappedType, artefact_id: conv.context_id, artefact_ref: null, artefact_title: title, link_confidence: 90 });
    }
  }

  // Text-based audit/release reference detection (e.g. "AUD-001", "RC-003")
  const audRefs = [...new Set(fullText.match(/aud-\d{3}/gi) ?? [])];
  for (const ref of audRefs) {
    const audit = evidence.audits.find((a) => {
      // match against engineering register number which we don't have here, use title heuristic
      return true; // can't match without register data; skip
    });
    void audit; // suppress unused
    // Only add if not already present
    if (!links.find((l) => l.artefact_ref === ref.toUpperCase())) {
      links.push({ artefact_type: "audit", artefact_id: null, artefact_ref: ref.toUpperCase(), artefact_title: null, link_confidence: 70 });
    }
  }

  const rcRefs = [...new Set(fullText.match(/rc-\d{3}/gi) ?? [])];
  for (const ref of rcRefs) {
    const rc = evidence.releases.find((r) => (r as Record<string, unknown>).rc_number === ref.toUpperCase());
    if (!links.find((l) => l.artefact_ref === ref.toUpperCase())) {
      links.push({ artefact_type: "release", artefact_id: rc?.id ?? null, artefact_ref: ref.toUpperCase(), artefact_title: rc ? (rc as Record<string, unknown>).title as string : null, link_confidence: rc ? 85 : 65 });
    }
  }

  return links;
}

// ─── Duplicate Detection ──────────────────────────────────────────────────────

function detectDuplicates(conversations: Conversation[]): number {
  // Simple heuristic: same title (case-insensitive, stripped)
  const titleMap = new Map<string, number>();
  for (const c of conversations) {
    const key = c.title.trim().toLowerCase();
    titleMap.set(key, (titleMap.get(key) ?? 0) + 1);
  }
  let duplicatePairs = 0;
  for (const count of titleMap.values()) {
    if (count > 1) duplicatePairs += count - 1;
  }
  return duplicatePairs;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

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

    // Load all active conversations
    const { data: convData, error: convErr } = await supabase
      .from("cc_ai_conversations")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: true });

    if (convErr) throw new Error(`Failed to load conversations: ${convErr.message}`);
    const conversations: Conversation[] = convData ?? [];

    // Collect engineering evidence once
    const evidence = await collectEngineeringEvidence(supabase);

    // Load existing artefact links to avoid duplication
    const { data: existingLinks } = await supabase
      .from("ecc_conversation_artefact_links")
      .select("conversation_id, artefact_id, artefact_ref");
    const existingLinkSet = new Set(
      (existingLinks ?? []).map((l: Record<string, unknown>) => `${l.conversation_id}:${l.artefact_id ?? l.artefact_ref}`)
    );

    const results: AnalysisResult[] = [];
    let autoCompletedCount = 0;
    let flaggedCount = 0;
    let orphanedCount = 0;
    let unclearTitleCount = 0;

    // Analyse each conversation
    for (const conv of conversations) {
      // Load messages for this conversation
      const { data: msgData } = await supabase
        .from("cc_ai_messages")
        .select("id, conversation_id, role, content, metadata, created_at")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: true });
      const messages: Message[] = msgData ?? [];

      // Discover artefact links
      const artefactLinks = discoverArtefactLinks(conv, messages, evidence);

      // Check title quality
      const unclear = isUnclearTitle(conv.title);
      if (unclear) unclearTitleCount++;

      // Analyse completion signals
      const { isComplete, confidence, reason, improvedTitle } = extractCompletionSignals(messages, evidence, conv);

      // Determine action
      let action: AnalysisResult["action"];
      let completionReason: string | null = null;

      if (messages.length === 0) {
        // Empty conversations — safe to flag for review but not auto-complete
        action = "flag_for_review";
        flaggedCount++;
      } else if (isComplete) {
        action = "auto_complete";
        completionReason = "historical_migration";
        autoCompletedCount++;
      } else if (confidence >= 40 && confidence < 70) {
        // Uncertain — flag for PO review
        action = "flag_for_review";
        flaggedCount++;
      } else {
        action = "leave_active";
      }

      if (artefactLinks.length === 0 && messages.length > 0) {
        orphanedCount++;
      }

      results.push({
        conversation_id: conv.id,
        title: improvedTitle ?? conv.title,
        original_title: conv.title,
        action,
        completion_reason: completionReason,
        improved_title: improvedTitle,
        artefact_links: artefactLinks,
        confidence,
        notes: reason,
      });
    }

    // Apply changes
    const now = new Date().toISOString();
    for (const result of results) {
      const updates: Record<string, unknown> = { updated_at: now };

      if (result.improved_title) updates.title = result.improved_title;

      if (result.action === "auto_complete") {
        updates.status = "completed";
        updates.completed_at = now;
        updates.auto_completed = true;
        updates.completion_reason = result.completion_reason;
        updates.migration_notes = result.notes;
      } else if (result.action === "flag_for_review") {
        updates.migration_notes = `Flagged for PO review: ${result.notes}`;
      }

      if (Object.keys(updates).length > 1) { // more than just updated_at
        await supabase.from("cc_ai_conversations").update(updates).eq("id", result.conversation_id);
      }

      // Insert new artefact links (skip duplicates)
      const newLinks = result.artefact_links.filter((l) => {
        const key = `${result.conversation_id}:${l.artefact_id ?? l.artefact_ref}`;
        return !existingLinkSet.has(key);
      });
      if (newLinks.length > 0) {
        await supabase.from("ecc_conversation_artefact_links").insert(
          newLinks.map((l) => ({
            conversation_id: result.conversation_id,
            artefact_type: l.artefact_type,
            artefact_id: l.artefact_id,
            artefact_ref: l.artefact_ref,
            artefact_title: l.artefact_title,
            link_confidence: l.link_confidence,
            link_source: "ai_analysis",
            notes: "Linked during historical migration analysis",
            linked_at: now,
          }))
        );
        // Track these so we don't re-insert during same run
        for (const l of newLinks) {
          existingLinkSet.add(`${result.conversation_id}:${l.artefact_id ?? l.artefact_ref}`);
        }
      }
    }

    // Generate recommendations
    const recommendations: Array<{ priority: string; title: string; description: string }> = [];

    if (orphanedCount > 0) {
      recommendations.push({
        priority: "medium",
        title: "Link Orphaned Conversations to Engineering Work",
        description: `${orphanedCount} conversation(s) have no linked engineering artefacts. Review these and manually link them to relevant features, decisions, or releases.`,
      });
    }
    if (unclearTitleCount > 0) {
      recommendations.push({
        priority: "low",
        title: "Improve Conversation Titles",
        description: `${unclearTitleCount} conversation(s) have generic or unclear titles. Rename these to reflect the engineering topic discussed.`,
      });
    }
    if (flaggedCount > 0) {
      recommendations.push({
        priority: "high",
        title: "Review Flagged Conversations",
        description: `${flaggedCount} conversation(s) were flagged for Product Owner review — completion status is uncertain. Review each and manually complete or keep active as appropriate.`,
      });
    }
    if (detectDuplicates(conversations) > 0) {
      recommendations.push({
        priority: "low",
        title: "Consolidate Duplicate Conversations",
        description: `Duplicate conversations were detected (same title). Consider merging related conversations or deleting empty duplicates.`,
      });
    }
    recommendations.push({
      priority: "info",
      title: "Future Conversations Auto-Complete Automatically",
      description: "Going forward, conversations linked to features, releases, or decisions that reach completion status will be automatically completed on the next analysis run.",
    });

    const remainingActive = conversations.length - autoCompletedCount;
    const duplicatePairs = detectDuplicates(conversations);

    // Build summary
    const summary = [
      `Analysed ${conversations.length} active conversation(s).`,
      autoCompletedCount > 0 ? `Auto-completed ${autoCompletedCount} conversation(s) with clear evidence of completion.` : "No conversations were automatically completed — insufficient completion evidence.",
      `${remainingActive} conversation(s) remain active.`,
      flaggedCount > 0 ? `${flaggedCount} conversation(s) flagged for Product Owner review.` : null,
      orphanedCount > 0 ? `${orphanedCount} orphaned conversation(s) have no linked engineering artefacts.` : null,
    ].filter(Boolean).join(" ");

    // Save health review
    const { data: reviewRecord, error: reviewErr } = await supabase
      .from("ecc_conversation_health_reviews")
      .insert({
        run_at: now,
        total_analysed: conversations.length,
        auto_completed_count: autoCompletedCount,
        remaining_active: remainingActive,
        flagged_for_review: flaggedCount,
        orphaned: orphanedCount,
        unclear_titles: unclearTitleCount,
        duplicate_pairs: duplicatePairs,
        summary,
        recommendations,
        conversation_details: results.map((r) => ({
          conversation_id: r.conversation_id,
          title: r.title,
          original_title: r.original_title,
          action: r.action,
          confidence: r.confidence,
          notes: r.notes,
          artefact_links_found: r.artefact_links.length,
        })),
      })
      .select()
      .single();

    if (reviewErr) console.error("Failed to save health review:", reviewErr.message);

    return new Response(
      JSON.stringify({
        success: true,
        review_id: reviewRecord?.id ?? null,
        summary,
        stats: {
          total_analysed: conversations.length,
          auto_completed: autoCompletedCount,
          remaining_active: remainingActive,
          flagged_for_review: flaggedCount,
          orphaned: orphanedCount,
          unclear_titles: unclearTitleCount,
          duplicate_pairs: duplicatePairs,
        },
        recommendations,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("analyze-conversations error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
