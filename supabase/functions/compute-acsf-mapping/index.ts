import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationOrganisationId, getStaffContext, hasAnyWorkspace } from "../_shared/organisation-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface AcsfLevels {
  learning: number;
  reading: number;
  writing: number;
  oral_communication: number;
  numeracy: number;
  digital_literacy: number;
}

interface UocProfile {
  code: string;
  title?: string;
  levels: AcsfLevels;
  source: "direct" | "inferred";
  libraryConfidence: "high" | "medium" | "low" | null;
  isCore: boolean;
}

// ── Layer 3: Inference engine ─────────────────────────────────────────────────
// Runs when a UoC is not found in the library.

const TRAINING_PACKAGE_DEFAULTS: Record<string, AcsfLevels> = {
  BSB: { learning: 3, reading: 3, writing: 3, oral_communication: 3, numeracy: 2, digital_literacy: 2 },
  CHC: { learning: 3, reading: 3, writing: 3, oral_communication: 3, numeracy: 2, digital_literacy: 2 },
  CPC: { learning: 3, reading: 3, writing: 2, oral_communication: 2, numeracy: 3, digital_literacy: 2 },
  SIT: { learning: 2, reading: 2, writing: 2, oral_communication: 3, numeracy: 2, digital_literacy: 2 },
  HLT: { learning: 3, reading: 3, writing: 3, oral_communication: 3, numeracy: 3, digital_literacy: 2 },
  TAE: { learning: 4, reading: 4, writing: 4, oral_communication: 4, numeracy: 3, digital_literacy: 3 },
  FNS: { learning: 3, reading: 3, writing: 3, oral_communication: 3, numeracy: 4, digital_literacy: 3 },
  ICT: { learning: 3, reading: 3, writing: 3, oral_communication: 3, numeracy: 3, digital_literacy: 4 },
  MEM: { learning: 3, reading: 3, writing: 3, oral_communication: 3, numeracy: 3, digital_literacy: 3 },
  TLI: { learning: 2, reading: 2, writing: 2, oral_communication: 2, numeracy: 2, digital_literacy: 2 },
  AHC: { learning: 2, reading: 3, writing: 2, oral_communication: 3, numeracy: 3, digital_literacy: 2 },
  SIS: { learning: 3, reading: 3, writing: 3, oral_communication: 3, numeracy: 2, digital_literacy: 2 },
  FSK: { learning: 2, reading: 2, writing: 2, oral_communication: 2, numeracy: 2, digital_literacy: 2 },
};

// Keywords that bump specific skill levels
const SKILL_KEYWORDS: Record<keyof AcsfLevels, string[]> = {
  reading:           ["read", "interpret", "analyse", "review", "identify", "research", "evaluate", "assess"],
  writing:           ["write", "prepare", "document", "record", "draft", "report", "produce", "describe", "develop"],
  oral_communication:["communicate", "present", "consult", "discuss", "negotiate", "facilitate", "liaise", "conduct", "brief"],
  numeracy:          ["calculate", "measure", "estimate", "financial", "cost", "budget", "quantity", "survey", "inspect"],
  digital_literacy:  ["software", "system", "computer", "online", "data", "digital", "database", "application", "ict", "network"],
  learning:          ["develop", "plan", "design", "create", "evaluate", "assess", "apply", "implement", "coordinate"],
};

const LEVEL_UP:   string[] = ["complex", "advanced", "strategic", "manage", "lead", "supervise", "coordinate", "develop", "establish", "monitor"];
const LEVEL_DOWN: string[] = ["basic", "simple", "assist", "support", "follow", "participate", "entry", "routine"];

// Extract AQF level hint from UoC code numeric prefix (e.g. BSB3xxx → cert III → 3)
function codeLevel(code: string): number {
  const m = code.match(/^[A-Z]+(\d)/);
  if (!m) return 3;
  const d = parseInt(m[1]);
  return d <= 1 ? 1 : d === 2 ? 2 : d === 3 ? 3 : d === 4 ? 3 : 4;
}

function inferLevels(code: string, title?: string): AcsfLevels {
  const pkg = (code.match(/^([A-Z]+)/) ?? [])[1] ?? "";
  const base: AcsfLevels = TRAINING_PACKAGE_DEFAULTS[pkg] ?? {
    learning: 3, reading: 3, writing: 3, oral_communication: 3, numeracy: 2, digital_literacy: 2,
  };

  // Adjust base levels to match the AQF level encoded in the UoC code
  const aqfLevel = codeLevel(code);
  const delta = aqfLevel - 3;
  const adjusted: Record<string, number> = {};
  for (const [key, val] of Object.entries(base)) {
    adjusted[key] = Math.max(1, Math.min(5, val + delta));
  }

  // Keyword adjustments on unit title
  const t = (title ?? code).toLowerCase();
  for (const [skill, keywords] of Object.entries(SKILL_KEYWORDS) as [keyof AcsfLevels, string[]][]) {
    if (keywords.some((k) => t.includes(k))) {
      adjusted[skill] = Math.min(5, adjusted[skill] + 1);
    }
  }

  // Level modifier keywords
  const up   = LEVEL_UP.some((k) => t.includes(k));
  const down = LEVEL_DOWN.some((k) => t.includes(k));
  if (up)   for (const k of Object.keys(adjusted)) adjusted[k] = Math.min(5, adjusted[k] + 1);
  if (down) for (const k of Object.keys(adjusted)) adjusted[k] = Math.max(1, adjusted[k] - 1);

  return {
    learning: adjusted.learning,
    reading: adjusted.reading,
    writing: adjusted.writing,
    oral_communication: adjusted.oral_communication,
    numeracy: adjusted.numeracy,
    digital_literacy: adjusted.digital_literacy,
  };
}

// ── Layer 4: Roll-up engine ───────────────────────────────────────────────────

function rollup(profiles: UocProfile[]): {
  levels: AcsfLevels;
  confidence: "high" | "medium" | "low";
  method: string;
  needsReview: boolean;
  reviewReason: string | null;
} {
  if (profiles.length === 0) {
    return {
      levels: { learning: 0, reading: 0, writing: 0, oral_communication: 0, numeracy: 0, digital_literacy: 0 },
      confidence: "low",
      method: "no_uoc_data",
      needsReview: true,
      reviewReason: "No UoC data available — mapping could not be computed",
    };
  }

  const coreProfiles = profiles.filter((p) => p.isCore);
  const electiveProfiles = profiles.filter((p) => !p.isCore);

  // Weighted average: core = 70%, elective = 30%
  // If no split data, equal weight
  const hasCoreSplit = coreProfiles.length > 0 && electiveProfiles.length > 0;

  const skills: (keyof AcsfLevels)[] = [
    "learning", "reading", "writing", "oral_communication", "numeracy", "digital_literacy",
  ];

  const computeAvg = (ps: UocProfile[]): AcsfLevels => {
    if (ps.length === 0) return { learning: 0, reading: 0, writing: 0, oral_communication: 0, numeracy: 0, digital_literacy: 0 };
    const sums = Object.fromEntries(skills.map((s) => [s, 0])) as Record<keyof AcsfLevels, number>;
    for (const p of ps) for (const s of skills) sums[s] += p.levels[s];
    return Object.fromEntries(skills.map((s) => [s, sums[s] / ps.length])) as AcsfLevels;
  };

  let levels: AcsfLevels;
  if (hasCoreSplit) {
    const coreAvg = computeAvg(coreProfiles);
    const electiveAvg = computeAvg(electiveProfiles);
    levels = Object.fromEntries(
      skills.map((s) => [s, coreAvg[s] * 0.7 + electiveAvg[s] * 0.3])
    ) as AcsfLevels;
  } else {
    levels = computeAvg(profiles);
  }

  // Safety override (Method B): if any CORE unit has level >= 4, floor all skills at 3
  const coreMaxLevel = Math.max(...coreProfiles.flatMap((p) => skills.map((s) => p.levels[s])));
  if (coreMaxLevel >= 4) {
    for (const s of skills) {
      if (levels[s] < 3) levels[s] = 3;
    }
  }

  // Round to integers (standard ACSF levels are whole numbers)
  for (const s of skills) levels[s] = Math.round(levels[s]);

  // Confidence score — combines match ratio with library confidence of matched units
  const directCount = profiles.filter((p) => p.source === "direct").length;
  const matchRatio  = directCount / profiles.length;

  // Penalise if matched units have low library confidence
  const directProfiles = profiles.filter((p) => p.source === "direct");
  const lowLibraryCount = directProfiles.filter((p) => p.libraryConfidence === "low").length;
  const libraryConfidencePenalty = directProfiles.length > 0 ? lowLibraryCount / directProfiles.length : 0;
  const adjustedRatio = matchRatio - libraryConfidencePenalty * 0.2;

  const confidence: "high" | "medium" | "low" =
    adjustedRatio >= 0.8 ? "high" : adjustedRatio >= 0.5 ? "medium" : "low";

  // Method label
  const allDirect    = directCount === profiles.length;
  const allInferred  = directCount === 0;
  const method = allDirect ? "uoc_direct" : allInferred ? "uoc_inferred" : "uoc_hybrid";

  // Review rules
  const levelSpread  = Math.max(...skills.map((s) => levels[s])) - Math.min(...skills.map((s) => levels[s]));
  const highDemand   = skills.some((s) => levels[s] >= 4);
  const reviewReasons: string[] = [];

  if (confidence === "low")  reviewReasons.push("Low mapping confidence — many UoCs were inferred rather than matched directly");
  if (highDemand)            reviewReasons.push("High ACSF demands detected (Level 4+ in one or more skills)");
  if (levelSpread >= 2)      reviewReasons.push("Wide ACSF level spread across skills — manual review recommended");

  const needsReview  = reviewReasons.length > 0;
  const reviewReason = needsReview ? reviewReasons.join("; ") : null;

  return { levels, confidence, method, needsReview, reviewReason };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function verifyAuth(req: Request) {
  // Issue #40: Administration staff of an active RTO membership only.
  const context = await getStaffContext(req.headers.get("Authorization"));
  return hasAnyWorkspace(context, ["administration"]) ? context : null;
}

// ── aXcelerate UoC fetch ──────────────────────────────────────────────────────

async function fetchAxcelerateUnits(
  code: string,
  axcId: number | null,
  apiBaseUrl: string,
  apiToken: string,
  wsToken: string
): Promise<{ code: string; title?: string; isCore?: boolean }[]> {
  const headers = { apitoken: apiToken, wstoken: wsToken, Accept: "application/json" };
  const base = apiBaseUrl.replace(/\/$/, "");

  const endpoints = [
    `${base}/rto/qualification/${encodeURIComponent(code)}/`,
    `${base}/rto/qualification/?qualificationcode=${encodeURIComponent(code)}`,
    ...(axcId ? [`${base}/courses/${axcId}/units/`, `${base}/courses/${axcId}/`] : []),
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();

      // Try to extract units from common field names
      const unitData: Record<string, unknown>[] =
        Array.isArray(data?.UNITS)         ? data.UNITS        :
        Array.isArray(data?.units)         ? data.units        :
        Array.isArray(data?.ELEMENTS)      ? data.ELEMENTS     :
        Array.isArray(data?.COMPETENCIES)  ? data.COMPETENCIES :
        Array.isArray(data?.modules)       ? data.modules      :
        Array.isArray(data)                ? data              : [];

      if (unitData.length === 0) continue;

      const pick = (obj: Record<string, unknown>, ...keys: string[]) => {
        for (const k of keys) if (obj[k] != null && obj[k] !== "") return String(obj[k]);
        return null;
      };

      return unitData.map((u) => ({
        code: pick(u, "UNITCODE", "CODE", "unitCode", "code", "COMPETENCYCODE") ?? "",
        title: pick(u, "UNITNAME", "NAME", "unitName", "name", "TITLE", "title") ?? undefined,
        isCore:
          String(pick(u, "UNITTYPE", "TYPE", "unitType", "type") ?? "").toLowerCase().includes("core") ||
          String(pick(u, "COREORELECTIVE", "coreOrElective", "CORE") ?? "").toLowerCase().includes("core"),
      })).filter((u) => u.code.length >= 4);
    } catch {
      // continue to next endpoint
    }
  }

  return [];
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const { qualification_id, triggered_by = "manual" } = body;

    if (!qualification_id) {
      return new Response(JSON.stringify({ error: "qualification_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Service role client for all DB operations
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Fetch the qualification
    const { data: qual, error: qualErr } = await supa
      .from("qualifications")
      .select("*")
      .eq("id", qualification_id)
      .eq("organisation_id", auth.organisationId)
      .maybeSingle();

    if (qualErr || !qual) {
      return new Response(JSON.stringify({ error: "Qualification not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load UoC library (including new metadata fields)
    const { data: library } = await supa
      .from("uoc_acsf_library")
      .select("uoc_code, uoc_title, learning_level, reading_level, writing_level, oral_comm_level, numeracy_level, digital_level, source_type, confidence, task_tags");

    const libraryMap = new Map<string, {
      learning_level: number; reading_level: number; writing_level: number;
      oral_comm_level: number; numeracy_level: number; digital_level: number;
      source_type: string; confidence: string; task_tags: string[];
    }>();
    for (const row of (library ?? [])) libraryMap.set(row.uoc_code.toUpperCase(), row);

    // Try to get aXcelerate credentials for UoC fetch. Issue #40: the platform
    // credentials belong to one RTO, so only that RTO's qualifications use them.
    const integrationOrganisationId = await getIntegrationOrganisationId(supa);
    const useIntegration = integrationOrganisationId === auth.organisationId;
    const noRow = Promise.resolve({ data: null });
    const [{ data: settingsRow }, { data: apiTokRow }, { data: wsTokRow }] = await Promise.all([
      useIntegration ? supa.from("settings").select("value").eq("key", "axcelerate_config").maybeSingle() : noRow,
      useIntegration ? supa.from("settings").select("value").eq("key", "axcelerate_api_token").maybeSingle() : noRow,
      useIntegration ? supa.from("settings").select("value").eq("key", "axcelerate_ws_token").maybeSingle() : noRow,
    ]);

    const apiBaseUrl: string | null = settingsRow?.value?.api_base_url ?? null;
    const apiToken: string | null   = typeof apiTokRow?.value === "string" ? apiTokRow.value : null;
    const wsToken: string | null    = typeof wsTokRow?.value === "string"  ? wsTokRow.value  : null;

    // ── Layer 1: Normalise & fetch UoC list ──────────────────────────────────

    let rawUnits: { code: string; title?: string; isCore?: boolean }[] = [];

    if (apiBaseUrl && apiToken && wsToken) {
      rawUnits = await fetchAxcelerateUnits(
        qual.code, qual.axcelerate_course_id, apiBaseUrl, apiToken, wsToken
      );
    }

    const uocSources: Record<string, "direct" | "inferred"> = {};

    // ── Layer 2 + 3: Look up or infer each UoC ───────────────────────────────

    const profiles: UocProfile[] = rawUnits
      .filter((u) => u.code.trim().length >= 4)
      .map((u) => {
        const upperCode = u.code.toUpperCase().trim();
        const lib = libraryMap.get(upperCode);

        if (lib) {
          uocSources[upperCode] = "direct";
          return {
            code: upperCode,
            title: u.title,
            levels: {
              learning:           lib.learning_level,
              reading:            lib.reading_level,
              writing:            lib.writing_level,
              oral_communication: lib.oral_comm_level,
              numeracy:           lib.numeracy_level,
              digital_literacy:   lib.digital_level,
            },
            source: "direct" as const,
            libraryConfidence: (lib.confidence ?? "medium") as "high" | "medium" | "low",
            isCore: u.isCore ?? false,
          };
        }

        // Inference fallback
        uocSources[upperCode] = "inferred";
        return {
          code: upperCode,
          title: u.title,
          levels: inferLevels(upperCode, u.title),
          source: "inferred" as const,
          libraryConfidence: null,
          isCore: u.isCore ?? false,
        };
      });

    // ── Layer 4: Roll-up ─────────────────────────────────────────────────────

    const { levels, confidence, method, needsReview, reviewReason } = rollup(profiles);

    const directCount  = profiles.filter((p) => p.source === "direct").length;
    const mappedMethod = profiles.length === 0 ? "qualification_library" : method;

    // If no UoC data was found, fall back to the existing qualification-level library or keep current mapping
    if (profiles.length === 0) {
      await supa.from("qualification_mapping_logs").insert({
        qualification_id,
        triggered_by,
        uoc_codes: [],
        uoc_sources: {},
        result_levels: null,
        confidence_score: "low",
        method: "no_uoc_data",
        uoc_count: 0,
        uoc_matched: 0,
        needs_review: true,
        review_reason: "aXcelerate did not return UoC data for this qualification",
        notes: "No UoC codes were retrievable — existing mapping preserved",
      });

      // Update qual: flag needs_review but don't overwrite existing mapping
      await supa.from("qualifications").update({
        needs_review: true,
        review_reason: "UoC data not available from aXcelerate — verify and set ACSF levels manually",
        mapping_method: "no_uoc_data",
        confidence_score: "low",
        uoc_count: 0,
        uoc_matched: 0,
      }).eq("id", qualification_id);

      return new Response(
        JSON.stringify({
          success: true,
          had_uoc_data: false,
          message: "No UoC data retrieved. Qualification flagged for review.",
          qualification_id,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Persist results ──────────────────────────────────────────────────────

    const skillDomainMap: Record<string, string> = {
      learning: "literacy", reading: "literacy", writing: "literacy",
      oral_communication: "language", numeracy: "numeracy", digital_literacy: "digital",
    };
    const skillNameMap: Record<string, string> = {
      learning: "Learning", reading: "Reading", writing: "Writing",
      oral_communication: "Oral Communication", numeracy: "Numeracy", digital_literacy: "Digital Literacy",
    };

    // Upsert requirements
    await supa.from("qualification_lln_requirements").delete().eq("qualification_id", qualification_id);
    const reqInserts = (Object.entries(levels) as [string, number][])
      .filter(([, v]) => v > 0)
      .map(([key, level]) => ({
        qualification_id,
        domain: skillDomainMap[key],
        acsf_skill: skillNameMap[key],
        minimum_acsf_level: level,
      }));
    if (reqInserts.length > 0) await supa.from("qualification_lln_requirements").insert(reqInserts);

    // Determine mapping status
    const mappingStatus = needsReview
      ? "review_required"
      : qual.mapping_source === "custom"
      ? "custom_mapping"
      : "default_mapping_applied";

    // Build default snapshot (keep existing unless this is a fresh mapping)
    const defaultSnapshot = qual.default_mapping_snapshot ?? Object.fromEntries(
      (Object.entries(levels) as [string, number][]).map(([k, v]) => [k, v])
    );

    // Update qualification
    await supa.from("qualifications").update({
      mapping_status: mappingStatus,
      mapping_source: qual.mapping_source === "custom" ? "custom" : "default",
      confidence_score: confidence,
      mapping_method: mappedMethod,
      needs_review: needsReview,
      review_reason: reviewReason,
      uoc_count: profiles.length,
      uoc_matched: directCount,
      default_mapping_snapshot: defaultSnapshot,
      mapping_version: (qual.mapping_version ?? 1) + 1,
    }).eq("id", qualification_id);

    // Insert mapping log
    await supa.from("qualification_mapping_logs").insert({
      qualification_id,
      triggered_by,
      uoc_codes: rawUnits.map((u) => u.code),
      uoc_sources: uocSources,
      result_levels: levels,
      confidence_score: confidence,
      method: mappedMethod,
      uoc_count: profiles.length,
      uoc_matched: directCount,
      needs_review: needsReview,
      review_reason: reviewReason,
    });

    return new Response(
      JSON.stringify({
        success: true,
        had_uoc_data: true,
        qualification_id,
        levels,
        confidence,
        method: mappedMethod,
        uoc_count: profiles.length,
        uoc_matched: directCount,
        needs_review: needsReview,
        review_reason: reviewReason,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: "An internal error occurred." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
