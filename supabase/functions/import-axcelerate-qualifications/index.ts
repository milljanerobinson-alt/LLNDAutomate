import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationOrganisationId, getStaffContext, hasAnyWorkspace } from "../_shared/organisation-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

async function verifyAuth(req: Request) {
  // Issue #40: Administration staff of the RTO that owns the platform
  // aXcelerate credentials only. Qualifications are written to that RTO.
  const authHeader = req.headers.get("Authorization");
  const context = await getStaffContext(authHeader);
  if (!hasAnyWorkspace(context, ["administration"])) return null;
  const integrationOrganisationId = await getIntegrationOrganisationId();
  if (!integrationOrganisationId || context!.organisationId !== integrationOrganisationId) return null;
  return context;
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return null;
}

// Detect whether a course is a qualification (not a workshop/short course).
// aXcelerate type codes: w=workshop, p=accredited program, el=e-learning.
// Strategy: only exclude things explicitly flagged as non-qualification types.
function detectIsQualification(course: Record<string, unknown>): boolean {
  const rawType = String(
    pick(course, "TYPE", "COURSETYPE", "courseType", "type", "COURSE_TYPE", "programType") ?? ""
  ).toLowerCase().trim();

  if (rawType) {
    // Explicit non-qualification types → exclude
    if (
      rawType === "w" ||
      rawType === "el" ||
      rawType === "s" ||
      rawType.includes("workshop") ||
      rawType.includes("short") ||
      rawType.includes("seminar") ||
      rawType.includes("event") ||
      rawType.includes("e-learning") ||
      rawType.includes("elearning")
    ) return false;

    // Known qualification types → include (p = accredited program)
    if (
      rawType === "p" ||
      rawType === "q" ||
      rawType === "1" ||
      rawType.includes("qual") ||
      rawType.includes("accredit") ||
      rawType.includes("cert") ||
      rawType.includes("diploma") ||
      rawType.includes("advanced") ||
      rawType.includes("program")
    ) return true;
  }

  // Fallback: include any course with a plausible qualification code
  // Covers: CPC10120 (letters+digits), 50702 (numeric), 30616QLD (digits+state suffix)
  const code = String(pick(course, "CODE", "COURSECODE", "code", "courseCode") ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{4,15}$/.test(code);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const action: string = body.action ?? "import";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: settingsRow } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "axcelerate_config")
      .maybeSingle();

    const { data: apiTokenRow } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "axcelerate_api_token")
      .maybeSingle();

    const { data: wsTokenRow } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "axcelerate_ws_token")
      .maybeSingle();

    const apiBaseUrl: string | undefined = settingsRow?.value?.api_base_url;
    const apiToken: string | undefined = typeof apiTokenRow?.value === "string" ? apiTokenRow.value : undefined;
    const wsToken: string | undefined = typeof wsTokenRow?.value === "string" ? wsTokenRow.value : undefined;

    if (!apiBaseUrl || !apiToken || !wsToken) {
      const missing = [];
      if (!apiBaseUrl) missing.push("API Base URL");
      if (!apiToken) missing.push("API Token");
      if (!wsToken) missing.push("WS Token");
      return new Response(
        JSON.stringify({
          error: `Missing credentials: ${missing.join(", ")}. Go to Settings → aXcelerate Integration, click "Change" on each token field, re-enter your tokens, and click "Save Credentials".`,
          missing_credentials: true,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── PREVIEW ──────────────────────────────────────────────────────────────
    if (action === "preview") {
      const baseUrl = apiBaseUrl.replace(/\/$/, "");
      const origin = new URL(baseUrl).origin;

      const axHeaders = { "apitoken": apiToken, "wstoken": wsToken, "Accept": "application/json" };

      const PAGE_SIZE = 100;
      const parseItems = (r: unknown): Record<string, unknown>[] =>
        Array.isArray(r) ? r
        : Array.isArray((r as any)?.courses) ? (r as any).courses
        : Array.isArray((r as any)?.qualifications) ? (r as any).qualifications
        : Array.isArray((r as any)?.data) ? (r as any).data
        : [];

      // Helper: fetch all pages from a URL, returns [] if URL returns non-ok
      async function fetchAllPages(firstUrl: string): Promise<Record<string, unknown>[]> {
        const r = await fetch(firstUrl, { method: "GET", headers: axHeaders, signal: AbortSignal.timeout(30000) });
        if (!r.ok) return [];
        const items = parseItems(await r.json());
        if (items.length < PAGE_SIZE) return items;
        const all = [...items];
        let start = PAGE_SIZE;
        while (true) {
          const pr = await fetch(`${firstUrl}${firstUrl.includes("?") ? "&" : "?"}start=${start}&limit=${PAGE_SIZE}`, { method: "GET", headers: axHeaders, signal: AbortSignal.timeout(30000) });
          if (!pr.ok) break;
          const page = parseItems(await pr.json());
          if (page.length === 0) break;
          all.push(...page);
          if (page.length < PAGE_SIZE) break;
          start += PAGE_SIZE;
        }
        return all;
      }

      // ── Fetch courses — no server-side type filter so all course types included ──
      const courseCandidates = [
        `${baseUrl}/courses/`,
        `${origin}/api/courses/`,
        `${origin}/courses/`,
      ];
      const deduped = [...new Set(courseCandidates)];

      let courseItems: Record<string, unknown>[] = [];
      let courseFetchOk = false;
      for (const url of deduped) {
        const r = await fetch(url, { method: "GET", headers: axHeaders, signal: AbortSignal.timeout(30000) });
        if (r.ok) {
          const items = parseItems(await r.json());
          if (items.length < PAGE_SIZE) {
            courseItems = items;
          } else {
            courseItems = [
              ...items,
              ...(await fetchAllPages(url).then(all => all.slice(PAGE_SIZE))),
            ];
          }
          courseFetchOk = true;
          break;
        }
      }

      if (!courseFetchOk) {
        return new Response(
          JSON.stringify({
            error: `Failed to fetch from aXcelerate`,
            detail: `Tried ${deduped.join(", ")} — all failed. Check your API Base URL and tokens.`,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // ── Fetch RTO qualifications (separate endpoint, if the instance supports it) ──
      const qualCandidates = [
        `${baseUrl}/rto/qualification/`,
        `${baseUrl}/qualifications/`,
        `${baseUrl}/qualification/`,
        `${origin}/api/rto/qualification/`,
        `${origin}/api/qualification/`,
      ];
      let rtoQualItems: Record<string, unknown>[] = [];
      for (const url of [...new Set(qualCandidates)]) {
        const r = await fetch(url, { method: "GET", headers: axHeaders, signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const items = parseItems(await r.json());
          if (items.length > 0) { rtoQualItems = items; break; }
        }
      }
      // Mark RTO qual records so we never filter them as workshops
      rtoQualItems = rtoQualItems.map(r => ({ ...r, _rto_qual: true }));

      const allCourses: Record<string, unknown>[] = [...courseItems, ...rtoQualItems];

      // Fetch existing qualifications keyed by axcelerate_course_id
      const { data: existing } = await supabase
        .from("qualifications")
        .select("id, axcelerate_course_id, code, name")
        .eq("organisation_id", auth.organisationId);

      const byAxcId = new Map<number, { code: string; name: string }>();
      for (const q of (existing ?? [])) {
        if (q.axcelerate_course_id != null) byAxcId.set(Number(q.axcelerate_course_id), q);
      }

      const qualifications: object[] = [];
      const skippedCount = { workshops: 0, incomplete: 0 };

      for (const course of allCourses) {
        const isRtoQual = course["_rto_qual"] === true;
        const courseId = pick(course, "ROWID", "QUALIFICATIONID", "ID", "COURSEID", "courseId", "DID");
        const code = pick(course, "CODE", "QUALIFICATIONCODE", "COURSECODE", "code", "courseCode", "qualificationCode");
        const name = pick(course, "NAME", "QUALIFICATIONNAME", "COURSENAME", "name", "courseName", "TITLE", "title");
        const rawType = isRtoQual ? "" : String(pick(course, "TYPE", "COURSETYPE", "courseType", "type") ?? "");

        if (!courseId || !code || !name) {
          skippedCount.incomplete++;
          continue;
        }

        const numId = Number(courseId);
        if (isNaN(numId)) {
          skippedCount.incomplete++;
          continue;
        }

        // Only skip courses explicitly typed as workshops/e-learning (never skip RTO qual records)
        const typeLower = isRtoQual ? "" : String(pick(course, "TYPE", "COURSETYPE", "courseType", "type") ?? "").toLowerCase().trim();
        if (typeLower === "w" || typeLower === "el") {
          skippedCount.workshops++;
          continue;
        }

        const existing = byAxcId.get(numId);
        const codeStr = String(code).trim();
        const nameStr = String(name).trim();

        let status: "new" | "exists" | "update";
        if (!existing) {
          status = "new";
        } else if (existing.code !== codeStr || existing.name !== nameStr) {
          status = "update";
        } else {
          status = "exists";
        }

        qualifications.push({ courseId: numId, code: codeStr, name: nameStr, type: rawType, status });
      }

      // Deduplicate by code — RTO qual records (appended last) win over course records
      const byCode = new Map<string, object>();
      for (const q of qualifications as any[]) byCode.set(q.code, q);
      const dedupedQuals = [...byCode.values()];

      // Sort: new first, then updates, then existing
      const ORDER = { new: 0, update: 1, exists: 2 };
      (dedupedQuals as any[]).sort((a, b) => ORDER[a.status as keyof typeof ORDER] - ORDER[b.status as keyof typeof ORDER] || a.code.localeCompare(b.code));

      return new Response(
        JSON.stringify({ qualifications: dedupedQuals, skipped_workshops: skippedCount.workshops, skipped_incomplete: skippedCount.incomplete }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── IMPORT ───────────────────────────────────────────────────────────────
    const courseIds: number[] = Array.isArray(body.course_ids) ? body.course_ids.map(Number) : [];
    const courses: { courseId: number; code: string; name: string }[] = Array.isArray(body.courses) ? body.courses : [];

    if (courses.length === 0) {
      return new Response(
        JSON.stringify({ message: "Nothing to import.", imported: 0, updated: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: existing } = await supabase
      .from("qualifications")
      .select("id, axcelerate_course_id, code, name, mapping_source")
      .eq("organisation_id", auth.organisationId);

    const byAxcId = new Map<number, { id: string; code: string; name: string; mapping_source: string | null }>();
    for (const q of (existing ?? [])) {
      if (q.axcelerate_course_id != null) byAxcId.set(Number(q.axcelerate_course_id), q);
    }

    // Load the full mapping library keyed by code
    const { data: libraryRows } = await supabase
      .from("qualification_mapping_library")
      .select("code, learning_level, reading_level, writing_level, oral_comm_level, numeracy_level, digital_level");

    const libraryByCode = new Map<string, Record<string, number>>();
    for (const row of (libraryRows ?? [])) {
      libraryByCode.set(row.code.toUpperCase(), {
        learning: row.learning_level,
        reading: row.reading_level,
        writing: row.writing_level,
        oral_communication: row.oral_comm_level,
        numeracy: row.numeracy_level,
        digital_literacy: row.digital_level,
      });
    }

    // Skill → domain map for inserting requirements
    const skillDomainMap: Record<string, string> = {
      learning: "literacy",
      reading: "literacy",
      writing: "literacy",
      oral_communication: "language",
      numeracy: "numeracy",
      digital_literacy: "digital",
    };
    const skillNameMap: Record<string, string> = {
      learning: "Learning",
      reading: "Reading",
      writing: "Writing",
      oral_communication: "Oral Communication",
      numeracy: "Numeracy",
      digital_literacy: "Digital Literacy",
    };

    let imported = 0, updated = 0;

    for (const { courseId, code, name } of courses) {
      if (!courseIds.includes(courseId)) continue;

      const codeUpper = code.toUpperCase();
      const libraryEntry = libraryByCode.get(codeUpper);

      const match = byAxcId.get(courseId);
      let qualId: string;

      if (match) {
        // Update name/code if changed
        if (match.code !== code || match.name !== name) {
          await supabase.from("qualifications").update({ code, name }).eq("id", match.id);
          updated++;
        }
        qualId = match.id;

        // Only auto-apply library mapping if no custom mapping has been set
        if (libraryEntry && match.mapping_source !== "custom") {
          const snapshot: Record<string, number> = {};
          const reqInserts: object[] = [];
          for (const [key, level] of Object.entries(libraryEntry)) {
            if (level == null) continue;
            snapshot[key] = level;
            reqInserts.push({
              qualification_id: qualId,
              domain: skillDomainMap[key],
              acsf_skill: skillNameMap[key],
              minimum_acsf_level: level,
            });
          }
          if (reqInserts.length > 0) {
            await supabase.from("qualification_lln_requirements").delete().eq("qualification_id", qualId);
            await supabase.from("qualification_lln_requirements").insert(reqInserts);
            await supabase.from("qualifications").update({
              mapping_status: "default_mapping_applied",
              mapping_source: "default",
              default_mapping_snapshot: snapshot,
            }).eq("id", qualId);
          }
        }
      } else {
        // New qualification — insert
        const { data: inserted } = await supabase
          .from("qualifications")
          .insert({ code, name, axcelerate_course_id: courseId, active: true, organisation_id: auth.organisationId })
          .select("id")
          .single();

        if (!inserted) continue;
        qualId = inserted.id;
        imported++;

        // Auto-apply library mapping if available
        if (libraryEntry) {
          const snapshot: Record<string, number> = {};
          const reqInserts: object[] = [];
          for (const [key, level] of Object.entries(libraryEntry)) {
            if (level == null) continue;
            snapshot[key] = level;
            reqInserts.push({
              qualification_id: qualId,
              domain: skillDomainMap[key],
              acsf_skill: skillNameMap[key],
              minimum_acsf_level: level,
            });
          }
          if (reqInserts.length > 0) {
            await supabase.from("qualification_lln_requirements").insert(reqInserts);
            await supabase.from("qualifications").update({
              mapping_status: "default_mapping_applied",
              mapping_source: "default",
              default_mapping_snapshot: snapshot,
            }).eq("id", qualId);
          } else {
            await supabase.from("qualifications").update({ mapping_status: "mapping_required" }).eq("id", qualId);
          }
        } else {
          await supabase.from("qualifications").update({ mapping_status: "mapping_required" }).eq("id", qualId);
        }
      }
    }

    return new Response(
      JSON.stringify({
        message: `Import complete: ${imported} added, ${updated} updated.`,
        imported,
        updated,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (_err) {
    return new Response(
      JSON.stringify({ error: "An internal error occurred." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
