import { createClient } from "jsr:@supabase/supabase-js@2";
import { isIntegrationStaff } from "../_shared/organisation-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

// ── Auth ──────────────────────────────────────────────────────────────────────

async function verifyAuth(req: Request, supabase: any): Promise<boolean> {
  const authHeader = req.headers.get("Authorization") || "";
  const cronSecret = req.headers.get("X-Cron-Secret") || "";

  if (authHeader === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) return true;

  if (cronSecret) {
    const { data: row } = await supabase.from("settings").select("value").eq("key", "cron_secret").maybeSingle();
    if (row?.value === cronSecret || row?.value?.toString() === cronSecret) return true;
  }

  const anonClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error } = await anonClient.auth.getUser();
  if (error || !user) return false;
  // Issue #40: only Administration/Technical staff of the RTO that owns the
  // platform aXcelerate credentials may trigger this integration.
  return await isIntegrationStaff(authHeader, ["administration", "technical"], supabase);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isYes(v: unknown): boolean {
  return typeof v === "string" && v.trim().toLowerCase() === "yes";
}

function extractCustomField(contact: any, name: string): string | null {
  for (const arr of [contact.CUSTOMFIELDS, contact.customFields, contact.customfields, contact.custom_fields]) {
    if (!Array.isArray(arr)) continue;
    const entry = arr.find((f: any) => (f.VARIABLE ?? f.variable ?? "").toLowerCase() === name.toLowerCase());
    if (entry != null) return entry.VALUE ?? entry.value ?? null;
  }
  const flat = `CUSTOMFIELD_${name.toUpperCase()}`;
  if (flat in contact) {
    const raw = contact[flat];
    return Array.isArray(raw) ? String(raw[0] ?? "") : raw == null ? null : String(raw);
  }
  return null;
}

function hasCustomFieldData(c: any): boolean {
  return (
    Array.isArray(c.CUSTOMFIELDS) || Array.isArray(c.customFields) ||
    Array.isArray(c.customfields) || Array.isArray(c.custom_fields) ||
    Object.keys(c).some(k => k.startsWith("CUSTOMFIELD_"))
  );
}

function normaliseList(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    for (const key of ["DATA", "data", "contacts", "CONTACTS", "results", "RESULTS", "items", "Items"]) {
      if (Array.isArray((raw as any)[key])) return (raw as any)[key];
    }
  }
  return [];
}

function extractContactId(c: any): number {
  return Number(c.CONTACTID ?? c.contactId ?? c.contactID ?? c.id ?? c.ID ?? NaN);
}

function auDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

async function tryGet(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; body: unknown; err?: string }> {
  try {
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(20_000) });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch (e: any) {
    return { ok: false, status: 0, body: null, err: e.message };
  }
}

// ── Phase 0: Custom-field filter search (LLN Robot approach) ──────────────────
//
// Ask aXcelerate directly for contacts where lln_quiz_required=Yes or
// digital_quiz_required=Yes. This is how LLN Robot discovers contacts without
// a watch list — it queries the flag rather than listing all contacts.
//
// Returns the discovered contact IDs and whether the endpoint actually worked.
// If all patterns return non-200, `supported` is false and the caller falls
// through to the general list strategies.

type Phase0Result = {
  ids: number[];
  supported: boolean; // true = at least one endpoint returned 200
  strategy: string;
  diagnostics: unknown[];
};

async function searchByQuizFlag(
  base: string,
  headers: Record<string, string>,
): Promise<Phase0Result> {
  const diag: unknown[] = [];
  const allIds = new Set<number>();
  let supported = false;
  let firstWorkingLabel = "";

  // Try each quiz field independently. For each field, stop at the first URL
  // pattern that returns 200 — that's the pattern this aXcelerate instance uses.
  for (const fieldName of ["LLN_QUIZ_REQUIRED", "DIGITAL_QUIZ_REQUIRED"]) {
    const patterns: [string, string][] = [
      [
        `${base}/contact/?CUSTOMFIELD_${fieldName}=Yes&returnCustomFields=true&limit=500`,
        `p0_${fieldName}_upper`,
      ],
      [
        `${base}/contact/?customfield_${fieldName.toLowerCase()}=yes&returnCustomFields=true&limit=500`,
        `p0_${fieldName}_lower`,
      ],
      [
        `${base}/contact/?${fieldName.toLowerCase()}=Yes&returnCustomFields=true&limit=500`,
        `p0_${fieldName}_flat`,
      ],
      [
        `${base}/contact/?variable=${fieldName}&value=Yes&returnCustomFields=true&limit=500`,
        `p0_${fieldName}_variable`,
      ],
    ];

    for (const [url, label] of patterns) {
      const r = await tryGet(url, headers);
      diag.push({ label, status: r.status, err: r.err });
      if (r.ok) {
        supported = true;
        if (!firstWorkingLabel) firstWorkingLabel = label;
        const contacts = normaliseList(r.body);
        for (const c of contacts) {
          const id = extractContactId(c);
          if (!isNaN(id) && id > 0) allIds.add(id);
        }
        break; // Found working pattern for this field — no need to try others
      }
    }
  }

  return {
    ids: [...allIds],
    supported,
    strategy: firstWorkingLabel || "phase0_no_match",
    diagnostics: diag,
  };
}

// ── General contact list with date-filter and pagination fallbacks ─────────────

type FetchResult = {
  contacts: any[];
  strategy: string;
  customFieldsInList: boolean;
  diagnostics: unknown[];
};

async function fetchContactList(
  base: string,
  headers: Record<string, string>,
  modifiedFrom: Date,
): Promise<FetchResult> {
  const diag: unknown[] = [];

  // Phase 1 — /contacts/search with date filters.
  // The docs show lastUpdated behaves as exact-date matching (not >=),
  // so we probe today + yesterday + the modifiedFrom date to cover recent contacts.
  // contactEntryDate covers newly created contacts; lastUpdated covers field updates.
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const datesToTry = [...new Set([
    today.toISOString().split("T")[0],
    yesterday.toISOString().split("T")[0],
    modifiedFrom.toISOString().split("T")[0],
  ])];

  const seen = new Set<number>();
  const searchContacts: any[] = [];
  let searchWorked = false;

  for (const date of datesToTry) {
    for (const param of ["contactEntryDate", "lastUpdated"]) {
      let pageCount = 0;
      for (let offset = 0; offset <= 10000; offset += 100) {
        const url = `${base}/contacts/search?${param}=${date}&displayLength=100&offset=${offset}`;
        const r = await tryGet(url, headers);
        if (offset === 0) diag.push({ label: `contacts_search_${param}_${date}`, status: r.status });
        if (!r.ok) break;
        searchWorked = true;
        const page = normaliseList(r.body);
        if (page.length === 0) break;
        for (const c of page) {
          const id = extractContactId(c);
          if (id > 0 && !seen.has(id)) { seen.add(id); searchContacts.push(c); }
        }
        pageCount++;
        if (page.length < 100) break;
      }
    }
  }

  if (searchWorked) {
    return {
      contacts: searchContacts,
      strategy: "contacts_search_date",
      customFieldsInList: searchContacts.some(hasCustomFieldData),
      diagnostics: diag,
    };
  }

  // Phase 2 — paginated unfiltered list.
  // aXcelerate defaults to 1 contact per page; we page through until empty.
  const listBases = [
    `${base}/contacts/`,
    `${base}/contact/`,
  ];

  for (const listBase of listBases) {
    const sizeParams = ["perpage=100", "per_page=100", "pageSize=100", "recordsPerPage=100", "limit=100"];
    let workingBase: string | null = null;

    for (const sizeParam of sizeParams) {
      const probeUrl = `${listBase}?${sizeParam}&returnCustomFields=true&p=1`;
      const r = await tryGet(probeUrl, headers);
      diag.push({ label: `probe_${listBase.includes("contacts") ? "plural" : "singular"}_${sizeParam.split("=")[0]}`, status: r.status, err: r.err });
      if (r.ok) {
        const contacts = normaliseList(r.body);
        if (contacts.length > 1) {
          workingBase = `${listBase}?${sizeParam}&returnCustomFields=true`;
          const all = [...contacts];
          for (let p = 2; p <= 50; p++) {
            const pageRes = await tryGet(`${workingBase}&p=${p}`, headers);
            if (!pageRes.ok) break;
            const page = normaliseList(pageRes.body);
            if (page.length === 0) break;
            all.push(...page);
            if (page.length < 100) break;
          }
          const cfInList = all.some(hasCustomFieldData);
          return { contacts: all, strategy: `paginated_${sizeParam.split("=")[0]}`, customFieldsInList: cfInList, diagnostics: diag };
        }
        if (contacts.length === 1 && workingBase === null) {
          workingBase = `${listBase}?returnCustomFields=true`;
        }
      }
    }

    if (workingBase !== null) {
      const all: any[] = [];
      for (let p = 1; p <= 500; p++) {
        const pageRes = await tryGet(`${workingBase}&p=${p}`, headers);
        if (!pageRes.ok) break;
        const page = normaliseList(pageRes.body);
        if (page.length === 0) break;
        all.push(...page);
      }
      if (all.length > 0) {
        const cfInList = all.some(hasCustomFieldData);
        return { contacts: all, strategy: `paginated_p_${listBase.includes("contacts") ? "plural" : "singular"}`, customFieldsInList: cfInList, diagnostics: diag };
      }
    }
  }

  return { contacts: [], strategy: "all_endpoints_failed", customFieldsInList: false, diagnostics: diag };
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const authed = await verifyAuth(req, supabase);
    if (!authed) return respond({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    // Default 48 h so the lastUpdated date covers at least yesterday + today.
    const hoursBack: number = typeof body.hours_back === "number" && body.hours_back > 0
      ? Math.min(body.hours_back, 168) : 48;

    const [{ data: cfgRow }, { data: apiTokenRow }, { data: wsTokenRow }] = await Promise.all([
      supabase.from("settings").select("value").eq("key", "axcelerate_config").maybeSingle(),
      supabase.from("settings").select("value").eq("key", "axcelerate_api_token").maybeSingle(),
      supabase.from("settings").select("value").eq("key", "axcelerate_ws_token").maybeSingle(),
    ]);

    const apiBaseUrl: string = cfgRow?.value?.api_base_url || "";
    const apiToken: string = typeof apiTokenRow?.value === "string" ? apiTokenRow.value : "";
    const wsToken: string = typeof wsTokenRow?.value === "string" ? wsTokenRow.value : "";

    if (!apiBaseUrl || !apiToken || !wsToken) {
      return respond({ error: "aXcelerate credentials not configured." }, 400);
    }

    const axBase = apiBaseUrl.replace(/\/$/, "");
    const axHdr: Record<string, string> = { apitoken: apiToken, wstoken: wsToken, Accept: "application/json" };
    const modifiedFrom = new Date(Date.now() - hoursBack * 3_600_000);
    const runStarted = new Date().toISOString();

    // ── Phase 0: LLN Robot approach — query by quiz flag directly ────────────
    // We cache whether aXcelerate supports this filter so we don't waste API
    // calls on every run once we know it doesn't work (405 = not supported).
    const { data: p0Cap } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "axcelerate_phase0_capability")
      .maybeSingle();
    const phase0Cached: string | null = typeof p0Cap?.value === "string" ? p0Cap.value : null;

    let phase0: Phase0Result = { ids: [], supported: false, strategy: "phase0_skipped_cached", diagnostics: [] };

    if (phase0Cached !== "false") {
      // Unknown or previously supported — try Phase 0
      phase0 = await searchByQuizFlag(axBase, axHdr);
      // Persist the result so future runs skip the probe if unsupported
      const capValue = phase0.supported ? "true" : "false";
      if (phase0Cached !== capValue) {
        await supabase.from("settings").upsert(
          { key: "axcelerate_phase0_capability", value: capValue },
          { onConflict: "key" }
        );
      }
    }

    let strategy: string;
    let apiIds: number[];
    let customFieldsInList: boolean;
    let diagnostics: unknown[];

    if (phase0.supported && phase0.ids.length > 0) {
      // aXcelerate supports the filter AND returned contacts — use them directly.
      strategy = phase0.strategy;
      apiIds = phase0.ids;
      customFieldsInList = false;
      diagnostics = phase0.diagnostics;
    } else {
      // Phase 0 either isn't supported or returned 0 results — fall through to
      // the general list strategies (date-filtered, then paginated).
      const listResult = await fetchContactList(axBase, axHdr, modifiedFrom);
      strategy = phase0.supported
        ? `${phase0.strategy}+${listResult.strategy}`
        : listResult.strategy;
      apiIds = [...new Set(
        listResult.contacts
          .map((c: any) => extractContactId(c))
          .filter((id: number) => !isNaN(id) && id > 0)
      )];
      customFieldsInList = listResult.customFieldsInList;
      diagnostics = [...phase0.diagnostics, ...listResult.diagnostics];
    }

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

    // Always merge in watch list IDs (catches contacts the API doesn't return)
    const { data: watchListSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "axcelerate_contact_watch_list")
      .maybeSingle();
    const watchListIds: number[] = Array.isArray(watchListSetting?.value)
      ? (watchListSetting.value as number[]).filter((id) => typeof id === "number" && id > 0)
      : [];

    const allIds: number[] = [...new Set([...apiIds, ...watchListIds])];

    // Skip contacts processed recently. Error/failed contacts get a 15-minute
    // cooldown; all others get 5 minutes.
    let idsToProcess: number[] = [];
    if (allIds.length > 0) {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60_000).toISOString();
      const { data: recentlyChecked } = await supabase
        .from("axcelerate_inbound_sync_log")
        .select("axcelerate_contact_id, status")
        .in("axcelerate_contact_id", allIds)
        .or(`and(status.neq.error,processed_at.gte.${fiveMinutesAgo}),and(status.eq.error,processed_at.gte.${fifteenMinutesAgo})`);

      const recentSet = new Set((recentlyChecked ?? []).map((r: any) => r.axcelerate_contact_id));
      idsToProcess = allIds.filter(id => !recentSet.has(id)).slice(0, 50);
    }

    let triggered = 0;
    let skipped = 0;
    const errors: { contactId: unknown; error: string }[] = [];

    for (const contactId of idsToProcess) {
      try {
        const syncRes = await fetch(`${supabaseUrl}/functions/v1/axcelerate-inbound-sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
          body: JSON.stringify({ contact_id: contactId }),
          signal: AbortSignal.timeout(30_000),
        });
        if (syncRes.ok) {
          triggered++;
        } else {
          const errBody = await syncRes.json().catch(() => ({}));
          errors.push({ contactId, error: errBody.error ?? `HTTP ${syncRes.status}` });
        }
      } catch (e: any) {
        errors.push({ contactId, error: e.message });
      }
    }

    skipped = allIds.length - idsToProcess.length;

    await supabase.from("audit_trail").insert({
      event_type: "axcelerate.bulk_sync.completed",
      category: "axcelerate_integration",
      severity: strategy === "all_endpoints_failed" ? "warning" : "info",
      description: `Bulk sync: strategy=${strategy}, list=${allIds.length} contacts, processed=${idsToProcess.length}, triggered=${triggered}, errors=${errors.length}`,
      source: "system",
      actor: "system",
      event_data: {
        hours_back: hoursBack,
        modified_from: modifiedFrom.toISOString(),
        strategy,
        custom_fields_in_list: customFieldsInList,
        phase0_supported: phase0.supported,
        phase0_ids: phase0.ids.length,
        total_in_list: allIds.length,
        ids_to_process: idsToProcess.length,
        triggered,
        skipped,
        errors: errors.slice(0, 20),
        diagnostics,
        run_started: runStarted,
      },
      timestamp: new Date().toISOString(),
    });

    return respond({
      success: true,
      strategy,
      phase0_supported: phase0.supported,
      phase0_ids: phase0.ids.length,
      custom_fields_in_list: customFieldsInList,
      total_in_list: allIds.length,
      ids_to_process: idsToProcess.length,
      triggered,
      skipped,
      errors: errors.slice(0, 20),
      diagnostics,
    });
  } catch (err: any) {
    return respond({ error: err.message || "Internal error" }, 500);
  }
});
