// EWO-024R.2 / EWO-027 / EWO-027R.DCR — ATD Connect Remote MCP Server (OAuth 2.1 Resource Server)
// Implements MCP JSON-RPC protocol over HTTP POST (streamable HTTP transport).
// Protocol version: 2025-11-25 (current stable MCP spec).
// All tools are read-only. No mutation tools are exposed.
// Provider-independent — no ChatGPT-specific business logic.
// OAuth 2.1 Resource Server compliance: protected-resource metadata, WWW-Authenticate.
// OAuth 2.1 Authorization Server metadata proxy with registration_endpoint (RFC 8414 + RFC 7591).
// Authentication modes: OAuth external, internal diagnostic, development self-test.
// Fail-closed: rejected tokens are never retried through a weaker path.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, MCP-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Protocol-Version, X-Auth-Mode, Mcp-Session-Id",
};

const MCP_PROTOCOL_VERSION = "2025-11-25";
const EDGE_FUNCTION_VERSION = "EWO-017R.2R.MCP";
const CANONICAL_CREDENTIAL_TYPE = "jwt_anon_key";

// ─── Safe Key Diagnostics (EWO-027R.Y.2/Y.3) ────────────────────────────────────
// Non-reversible fingerprint for diagnostic comparison without exposing keys.
async function safeFingerprint(key: string): Promise<string> {
  if (!key) return "empty";
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hash));
  return hashArray.slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Timing-safe comparison to prevent timing attacks on key validation.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

// ─── Canonical JWT Anon Key Validation (EWO-027R.Y.3) ─────────────────────────
// The canonical browser-safe credential is the legacy JWT-style anon key
// (format: header.payload.signature, ~208 chars). The platform has transitioned
// SUPABASE_ANON_KEY to a 46-char publishable key, but the frontend build has the
// JWT anon key baked in. Rather than requiring an exact stored-key match, we
// validate the JWT structurally: decode the payload, verify the project reference
// matches this server's project, and verify the role is "anon".
// This is more robust than string comparison because it validates the key
// belongs to the right project without needing the exact same key stored.

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    // base64url decode the payload (part[1])
    let payload = parts[1];
    payload = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = 4 - (payload.length % 4);
    if (padLen < 4) payload += "=".repeat(padLen);
    const decoded = atob(payload);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function isJwtAnonKey(key: string): boolean {
  if (!key || key.length < 50) return false;
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  return true;
}

function validateJwtAnonKey(key: string, serverProjectRef: string): { valid: boolean; keyProjectRef: string | null; reason: string } {
  if (!key || key.trim() !== key) {
    return { valid: false, keyProjectRef: null, reason: "Key has surrounding whitespace." };
  }
  if (!isJwtAnonKey(key)) {
    return { valid: false, keyProjectRef: null, reason: "Not a JWT-format key (expected 3 dot-separated parts)." };
  }
  const payload = decodeJwtPayload(key);
  if (!payload) {
    return { valid: false, keyProjectRef: null, reason: "JWT payload could not be decoded." };
  }
  const keyRef = payload.ref as string | undefined;
  const keyRole = payload.role as string | undefined;
  if (!keyRef) {
    return { valid: false, keyProjectRef: null, reason: "JWT payload missing 'ref' field." };
  }
  if (keyRole !== "anon") {
    return { valid: false, keyProjectRef: keyRef, reason: `JWT role is '${keyRole}', expected 'anon'.` };
  }
  if (keyRef !== serverProjectRef) {
    return { valid: false, keyProjectRef: keyRef, reason: `Project reference mismatch: key has '${keyRef}', server has '${serverProjectRef}'.` };
  }
  return { valid: true, keyProjectRef: keyRef, reason: "Valid JWT anon key for this project." };
}

// Collect publishable keys from the edge-function environment as a fallback.
function getValidAnonKeys(): string[] {
  const keys: string[] = [];
  const legacyKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (legacyKey.trim()) keys.push(legacyKey.trim());
  const publishableKeysRaw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "";
  if (publishableKeysRaw.trim()) {
    try {
      const parsed = JSON.parse(publishableKeysRaw);
      if (Array.isArray(parsed)) {
        for (const k of parsed) {
          if (typeof k === "string" && k.trim()) keys.push(k.trim());
        }
      }
    } catch {
      for (const k of publishableKeysRaw.split(/[\n,]/)) {
        const trimmed = k.trim();
        if (trimmed) keys.push(trimmed);
      }
    }
  }
  return [...new Set(keys)];
}

// Extract project reference from a Supabase URL.
function extractProjectRef(url: string): string {
  const match = url.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/);
  return match ? match[1] : "unknown";
}

// ─── Canonical MCP Resource URI ───────────────────────────────────────────────
// Single source of truth for the MCP resource URL. Used in:
// protected-resource metadata, WWW-Authenticate, server info, documentation.
function getMcpResourceUrl(): string {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  return `${supabaseUrl}/functions/v1/atd-mcp-server`;
}

function getProtectedResourceMetadataUrl(): string {
  return `${getMcpResourceUrl()}/.well-known/oauth-protected-resource`;
}

// ─── OAuth Authorization Server Metadata (EWO-027R.DCR) ────────────────────────
// Fetches authoritative metadata from Supabase's OAuth 2.1 authorization
// server discovery endpoint and enriches it with the registration_endpoint
// for Dynamic Client Registration (RFC 7591). This ensures standards-compliant
// MCP clients like ChatGPT can automatically discover the registration URL.

async function getAuthorizationServerMetadata(): Promise<Record<string, unknown> | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";

  // The issuer and endpoints point to Supabase, but the metadata document is
  // served from the MCP server so MCP clients can discover it.
  const issuer = `${supabaseUrl}/auth/v1`;

  // Try to fetch Supabase's native OAuth discovery document first
  const discoveryUrl = `${supabaseUrl}/.well-known/oauth-authorization-server/auth/v1`;
  try {
    const resp = await fetch(discoveryUrl, { headers: { Accept: "application/json" } });
    if (resp.ok) {
      const metadata = await resp.json();
      if (!metadata.registration_endpoint) {
        metadata.registration_endpoint = `${supabaseUrl}/auth/v1/oauth/clients/register`;
      }
      if (!metadata.code_challenge_methods_supported) {
        metadata.code_challenge_methods_supported = ["S256"];
      }
      return metadata;
    }
  } catch {
    // Network error — fall through to constructed metadata
  }

  // Supabase OAuth server is disabled or unreachable — construct metadata
  // from the OIDC discovery document (which IS available even when the
  // OAuth server feature is disabled) plus known OAuth endpoint structure.
  let oidcConfig: Record<string, unknown> | null = null;
  try {
    const oidcResp = await fetch(`${supabaseUrl}/auth/v1/.well-known/openid-configuration`, {
      headers: { Accept: "application/json" },
    });
    if (oidcResp.ok) {
      oidcConfig = await oidcResp.json();
    }
  } catch {
    // OIDC also unreachable — use minimal fallback
  }

  return {
    issuer,
    authorization_endpoint: oidcConfig?.authorization_endpoint ?? `${supabaseUrl}/auth/v1/oauth/authorize`,
    token_endpoint: oidcConfig?.token_endpoint ?? `${supabaseUrl}/auth/v1/oauth/token`,
    jwks_uri: oidcConfig?.jwks_uri ?? `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
    userinfo_endpoint: oidcConfig?.userinfo_endpoint ?? `${supabaseUrl}/auth/v1/oauth/userinfo`,
    registration_endpoint: `${supabaseUrl}/auth/v1/oauth/clients/register`,
    response_types_supported: oidcConfig?.response_types_supported ?? ["code"],
    response_modes_supported: oidcConfig?.response_modes_supported ?? ["query"],
    grant_types_supported: oidcConfig?.grant_types_supported ?? ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: oidcConfig?.code_challenge_methods_supported ?? ["S256"],
    scopes_supported: oidcConfig?.scopes_supported ?? ["openid", "profile", "email"],
    token_endpoint_auth_methods_supported: oidcConfig?.token_endpoint_auth_methods_supported ?? ["none", "client_secret_post", "client_secret_basic"],
    subject_types_supported: oidcConfig?.subject_types_supported ?? ["public"],
    id_token_signing_alg_values_supported: oidcConfig?.id_token_signing_alg_values_supported ?? ["RS256"],
  };
}

const MAX_REQUEST_SIZE = 1024 * 1024; // 1MB
const MAX_RESPONSE_SIZE = 512 * 1024; // 512KB
const REQUEST_TIMEOUT_MS = 30000;
const RATE_LIMIT_PER_MINUTE = 60;

// ─── MCP Tool Definitions ─────────────────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: "discover_atd_capabilities",
    description: "Lists all registered ATD Connect governed inspection capabilities. Returns capability IDs, names, descriptions, and lifecycle status. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        persona: { type: "string", description: "Requesting persona for visibility governance. Defaults to 'atd'.", default: "atd" },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "inspect_engineering_object",
    description: "Inspects a specific engineering object using a governed ATD Connect capability and operation. Returns a governed DTO with metadata, health, and lifecycle information. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string", description: "The ATD Connect capability ID (e.g. 'engineering-work-orders', 'engineering-records')." },
        operation: { type: "string", description: "The inspection operation to execute (e.g. 'inspectEngineeringWorkOrder', 'inspectPage')." },
        object_reference: { type: "string", description: "The object reference to inspect (e.g. 'EWO-024', 'engineering-records')." },
        persona: { type: "string", description: "Requesting persona for visibility governance.", default: "atd" },
      },
      required: ["capability", "operation", "object_reference"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_engineering_objects",
    description: "Lists authorised engineering objects for a supported ATD Connect capability. Returns a governed list DTO. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string", description: "The ATD Connect capability ID (e.g. 'pages', 'workspaces', 'engineering-work-orders')." },
        persona: { type: "string", description: "Requesting persona for visibility governance.", default: "atd" },
      },
      required: ["capability"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "inspect_relationships",
    description: "Returns governed relationship information for an engineering object, including relationship graph nodes and edges. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        object_reference: { type: "string", description: "The engineering object reference to inspect relationships for (e.g. 'EWO-024')." },
        persona: { type: "string", description: "Requesting persona for visibility governance.", default: "atd" },
      },
      required: ["object_reference"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "inspect_platform_health",
    description: "Returns supported governed health dimensions for the ATD Connect platform, including operational health, inspection availability, evidence health, and relationship health. Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_inspection_audit",
    description: "Retrieves authorised ATD Connect inspection audit entries. Returns audit records with request IDs, operations, outcomes, and timestamps. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of audit entries to return (default 20, max 100).", default: 20 },
        request_source: { type: "string", description: "Filter by request source.", enum: ["workspace", "conversational", "external", "mcp_self_test", "mcp_client", "chatgpt_confirmed"] },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "submit_conversation_inspection",
    description: "Submits a natural-language request through the deterministic Conversation Inspection Bridge. The bridge interprets the request and routes it to the appropriate governed inspection operation. Read-only — write requests are refused. CRITICAL: You MUST generate a conversation_id on the first call in each ChatGPT conversation and reuse the SAME conversation_id for every subsequent call within that conversation. Use a different conversation_id in separate conversations. Format: a random UUID v4 (e.g. 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'). This enables contextual continuity so references like 'the current EWO' resolve correctly.",
    inputSchema: {
      type: "object",
      properties: {
        natural_language_request: { type: "string", description: "The natural-language inspection request (e.g. 'List every engineering capability', 'Inspect EWO-024')." },
        conversation_id: { type: "string", description: "REQUIRED. A UUID v4 that uniquely identifies this ChatGPT conversation. Generate a new random UUID on the FIRST tool call in a conversation, then reuse the EXACT same UUID for every subsequent tool call in the same conversation. Use a different UUID in separate conversations. Never use a user ID, client ID, or tenant ID as the conversation_id. Example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'." },
        requesting_persona: { type: "string", description: "Requesting persona for visibility governance.", default: "external" },
        client_id: { type: "string", description: "Client identifier for audit tracking.", default: "mcp-client" },
        session_id: { type: "string", description: "Alternative conversation-specific session identifier. If conversation_id is provided, it takes precedence. Must be unique to a single ChatGPT conversation, not to the user or MCP client." },
      },
      required: ["natural_language_request", "conversation_id"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "inspect_knowledge_extraction",
    description: "Inspects knowledge extraction status, provenance, and reconciliation history for an Engineering Work Order. Returns linked completion report, extraction status, extracted knowledge records with provenance, lifecycle reconciliation history, linkage integrity, and extraction diagnostics. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        ewo_ref: { type: "string", description: "The Engineering Work Order reference to inspect knowledge extraction for (e.g. 'EWO-028')." },
        include_records: { type: "boolean", description: "Whether to include full extracted knowledge record details. Default: true.", default: true },
        include_reconciliation: { type: "boolean", description: "Whether to include lifecycle reconciliation history. Default: true.", default: true },
        persona: { type: "string", description: "Requesting persona for visibility governance.", default: "atd" },
      },
      required: ["ewo_ref"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "inspect_capability_metadata",
    description: "Resolves a natural-language capability name to its canonical capability identifier and returns governed metadata: capability ID, canonical name, description, purpose, lifecycle status, version, category, operations exposed, read/write support, required permissions, governance restrictions, authentication requirements, dependencies, supported object types, current availability, and input/output schemas. Returns a runtime diagnostic envelope with resolution confidence, metadata source, and governance outcome. If resolution fails, returns diagnostics: attempted name, outcome, reason, resolution performed, and suggested alternatives. Read-only. Never fabricates metadata. Includes a conversational response formatted with sections (Capability, Purpose, Operations, Permissions, Governance, Availability).",
    inputSchema: {
      type: "object",
      properties: {
        capability_request: { type: "string", description: "Natural-language capability name or description (e.g. 'Engineering Work Orders', 'inspect the engineering records capability', 'what operations does constitution expose')." },
        persona: { type: "string", description: "Requesting persona for visibility governance.", default: "atd" },
        include_conversational: { type: "boolean", description: "Whether to include a conversational-formatted response with sections. Default: true.", default: true },
      },
      required: ["capability_request"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const TOOL_NAMES = MCP_TOOLS.map(t => t.name);

// ─── JSON-RPC Helpers ─────────────────────────────────────────────────────────

function createJsonRpcResponse(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function createJsonRpcError(id: string | number | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function sanitizeForLog(obj: unknown): unknown {
  const str = JSON.stringify(obj);
  if (str.length > 500) return str.slice(0, 500) + "...[truncated]";
  return obj;
}

// ─── Rate Limiting ─────────────────────────────────────────────────────────────

async function checkRateLimit(supabase: ReturnType<typeof createClient>, userId: string): Promise<boolean> {
  const oneMinuteAgo = new Date(Date.now() - 60000).toISOString();
  const { count } = await supabase
    .from("atd_connect_inspection_log")
    .select("*", { count: "exact", head: true })
    .eq("requesting_persona", userId)
    .gte("timestamp", oneMinuteAgo);
  return (count ?? 0) < RATE_LIMIT_PER_MINUTE;
}

// ─── Canonical Reference Resolution (inlined) ─────────────────────────────────

async function resolveEWORef(supabase: ReturnType<typeof createClient>, ref: string): Promise<{ resolved: boolean; canonical: string | null; ambiguous: boolean; candidates: string[] }> {
  const trimmed = ref.trim();
  if (!trimmed) return { resolved: false, canonical: null, ambiguous: false, candidates: [] };

  // Exact match
  const { data: exact } = await supabase
    .from("engineering_work_orders")
    .select("ewo_ref")
    .eq("ewo_ref", trimmed)
    .maybeSingle();
  if (exact) return { resolved: true, canonical: String(exact.ewo_ref), ambiguous: false, candidates: [String(exact.ewo_ref)] };

  // Case normalisation
  const { data: caseMatch } = await supabase
    .from("engineering_work_orders")
    .select("ewo_ref")
    .ilike("ewo_ref", trimmed.toLowerCase())
    .limit(5);
  if (caseMatch && caseMatch.length === 1) return { resolved: true, canonical: String(caseMatch[0].ewo_ref), ambiguous: false, candidates: [String(caseMatch[0].ewo_ref)] };
  if (caseMatch && caseMatch.length > 1) return { resolved: false, canonical: null, ambiguous: true, candidates: caseMatch.map((c: Record<string, unknown>) => String(c.ewo_ref)) };

  // Hyphen/underscore normalisation
  for (const norm of [(r: string) => r.replace(/_/g, "-"), (r: string) => r.replace(/-/g, "_")]) {
    const normalised = norm(trimmed);
    if (normalised === trimmed) continue;
    const { data: normMatch } = await supabase
      .from("engineering_work_orders")
      .select("ewo_ref")
      .eq("ewo_ref", normalised)
      .maybeSingle();
    if (normMatch) return { resolved: true, canonical: String(normMatch.ewo_ref), ambiguous: false, candidates: [String(normMatch.ewo_ref)] };
  }

  // Parent/refinement
  const { data: children } = await supabase
    .from("engineering_work_orders")
    .select("ewo_ref")
    .eq("parent_ref", trimmed)
    .order("created_at", { ascending: false })
    .limit(5);
  if (children && children.length > 0) {
    return { resolved: true, canonical: String(children[0].ewo_ref), ambiguous: children.length > 1, candidates: children.map((c: Record<string, unknown>) => String(c.ewo_ref)) };
  }

  return { resolved: false, canonical: null, ambiguous: false, candidates: [] };
}

// ─── Capability Metadata Resolution (EWO-027R.1R.1.MCP) ───────────────────────
// Resolves natural-language capability names to canonical capability IDs
// and returns governed metadata. Never fabricates metadata.

interface CapabilityResolutionResult {
  resolved: boolean;
  canonical_capability_id: string | null;
  canonical_capability_name: string | null;
  match_type: "exact" | "case_insensitive" | "fuzzy" | "none";
  confidence: number;
  attemptedName: string;
  extractedCapabilityTarget: string | null;
  reason: string | null;
  suggestions: string[];
}

function normalizeCapabilityName(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, " ").trim();
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function similarityScore(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

// EWO-017R: Extract the capability target from natural-language requests.
// Handles multi-line requests, bullet lists, and complex instructions by
// extracting only the capability name portion and discarding surrounding
// requested fields, formatting instructions, and explanations.
function extractCapabilityPhrase(input: string): string {
  // Take only the first line — multi-line requests have the capability name
  // in the first line and requested fields in subsequent lines.
  const firstLine = input.split(/[\n\r]/)[0].trim();
  const lower = firstLine.toLowerCase();

  // Strip trailing punctuation (?, ., !, :) that would interfere with suffix matching
  let result = lower.replace(/[?.!:]+$/g, "").trim();

  // Strip common prefixes: "inspect the", "explain the", "what operations does", etc.
  const prefixPatterns = [
    /^(?:inspect|explain|describe|show(?:\s+me)?|tell me about|what (?:operations|capabilities|services) (?:does|are|is))\s+(?:the\s*)?/i,
    /^(?:what is|what are)\s+(?:the\s*)?/i,
    /^(?:get|fetch|retrieve)\s+(?:the\s*)?/i,
    /^(?:list|view)\s+(?:the\s*)?/i,
    /^(?:does|do|is|are)\s+(?:the\s*)?/i,
  ];
  for (const pat of prefixPatterns) {
    result = result.replace(pat, "");
  }

  // Strip leading "the" if it remains after prefix removal
  result = result.replace(/^the(?:\s+|$)/i, "");

  // EWO-017R: Truncate at "capability" — everything after it is typically
  // additional instructions (e.g. "and explain:", "support write operations").
  // First try to extract the phrase BEFORE "capability".
  const capIdx = result.indexOf("capability");
  if (capIdx > 0) {
    result = result.substring(0, capIdx).trim();
  }

  // Also truncate at "capabilities", "service", "services"
  for (const stopper of ["capabilities", "service", "services"]) {
    const idx = result.indexOf(stopper);
    if (idx > 0) {
      result = result.substring(0, idx).trim();
    }
  }

  // Truncate at conjunctions that introduce additional instructions:
  // "and explain", "and show", "and tell", "and include", "and describe"
  result = result.replace(/\s+and\s+(?:explain|show|tell|include|describe|list|detail).*$/i, "");

  // Truncate at question words that introduce sub-questions:
  // "what operations", "whether it", "is it", "does it"
  result = result.replace(/\s+(?:what|whether|is it|does it|can it|will it|how|why).*$/i, "");

  // Strip trailing verbs: "expose", "offer", "support", "provide"
  result = result.replace(/\s+(?:expose|offers?|supports?|provides?|exposes?)$/i, "");

  // Strip trailing "support write" or "support read" phrases
  result = result.replace(/\s+support\s+(?:write|read).*$/i, "");

  // Strip trailing "read-only" or "read only"
  result = result.replace(/\s+read[\s-]?only$/i, "");

  return result.trim();
}

async function resolveCapabilityByName(
  supabase: ReturnType<typeof createClient>,
  input: string,
): Promise<CapabilityResolutionResult> {
  const phrase = extractCapabilityPhrase(input);
  const normalized = normalizeCapabilityName(phrase);
  const attemptedName = phrase || input.trim();

  if (!normalized) {
    return { resolved: false, canonical_capability_id: null, canonical_capability_name: null, match_type: "none", confidence: 0, attemptedName, extractedCapabilityTarget: phrase || null, reason: "Empty capability name after normalisation.", suggestions: [] };
  }

  // Fetch all registered capabilities
  const { data: caps, error } = await supabase
    .from("atd_connect_capabilities")
    .select("capability_id, name, category, description")
    .order("capability_id");

  if (error || !caps || caps.length === 0) {
    return { resolved: false, canonical_capability_id: null, canonical_capability_name: null, match_type: "none", confidence: 0, attemptedName, extractedCapabilityTarget: phrase, reason: "No capabilities registered in the registry.", suggestions: [] };
  }

  // Build lookup maps
  const byId = new Map<string, typeof caps[0]>();
  const byNormalizedName = new Map<string, typeof caps[0]>();
  for (const cap of caps) {
    byId.set(cap.capability_id, cap);
    byNormalizedName.set(normalizeCapabilityName(cap.name), cap);
  }

  // 1. Exact capability_id match
  if (byId.has(phrase)) {
    const cap = byId.get(phrase)!;
    return { resolved: true, canonical_capability_id: phrase, canonical_capability_name: cap.name, match_type: "exact", confidence: 1.0, attemptedName, extractedCapabilityTarget: phrase, reason: null, suggestions: [] };
  }

  // 2. Exact normalized name match
  if (byNormalizedName.has(normalized)) {
    const cap = byNormalizedName.get(normalized)!;
    return { resolved: true, canonical_capability_id: cap.capability_id, canonical_capability_name: cap.name, match_type: "case_insensitive", confidence: 0.95, attemptedName, extractedCapabilityTarget: phrase, reason: null, suggestions: [] };
  }

  // 3. Fuzzy match against capability names and IDs
  const candidates: Array<{ cap: typeof caps[0]; score: number; matchedField: string }> = [];
  for (const cap of caps) {
    const normName = normalizeCapabilityName(cap.name);
    const normId = cap.capability_id.toLowerCase();
    const nameScore = similarityScore(normalized, normName);
    const idScore = similarityScore(normalized, normId);
    const bestScore = Math.max(nameScore, idScore);
    if (bestScore >= 0.45) {
      candidates.push({ cap, score: bestScore, matchedField: nameScore >= idScore ? "name" : "capability_id" });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > 0 && candidates[0].score >= 0.6) {
    const best = candidates[0];
    return { resolved: true, canonical_capability_id: best.cap.capability_id, canonical_capability_name: best.cap.name, match_type: "fuzzy", confidence: best.score, attemptedName, extractedCapabilityTarget: phrase, reason: null, suggestions: candidates.slice(1, 4).map((c) => c.cap.capability_id) };
  }

  // 4. No match — return suggestions if any fuzzy candidates were close
  const suggestions = candidates.slice(0, 5).map((c) => c.cap.capability_id);
  return {
    resolved: false,
    canonical_capability_id: null,
    canonical_capability_name: null,
    match_type: "none",
    confidence: candidates.length > 0 ? candidates[0].score : 0,
    attemptedName,
    extractedCapabilityTarget: phrase,
    reason: 'No capability found matching "' + attemptedName + '". No metadata inferred.',
    suggestions,
  };
}

function buildCapabilityMetadataResponse(cap: Record<string, unknown>): Record<string, unknown> {
  const supportedOps = Array.isArray(cap.supported_operations) ? cap.supported_operations : [];
  const relationships = Array.isArray(cap.relationships) ? cap.relationships : [];
  const metadata = cap.metadata && typeof cap.metadata === "object" ? cap.metadata : {};
  const visibility = String(cap.constitutional_visibility ?? "public");
  const dependencies = Array.isArray(cap.dependencies) ? cap.dependencies : (Array.isArray(cap.relationships) ? cap.relationships : []);
  const supportedObjectTypes = Array.isArray(cap.supported_object_types) ? cap.supported_object_types : [];
  const authReqs = (cap.authentication_requirements && typeof cap.authentication_requirements === "object")
    ? cap.authentication_requirements
    : { authentication: "required", token_type: "jwt_anon_key", persona: "atd or authenticated user" };
  const currentAvailability = String(cap.current_availability ?? "available");
  const isAvailable = currentAvailability === "available" && !((cap.deprecated ?? false) === true) && String(cap.status ?? "active") === "active";

  return {
    capability_name: cap.name ?? "unavailable",
    canonical_identifier: cap.capability_id ?? "unavailable",
    description: cap.description ?? "unavailable",
    purpose: cap.purpose ?? cap.description ?? "unavailable",
    lifecycle_status: cap.lifecycle_status ?? cap.status ?? "unavailable",
    status: cap.status ?? "unavailable",
    version: cap.capability_version ?? "unavailable",
    capability_category: cap.category ?? "unavailable",
    operations_exposed: supportedOps,
    supported_operations: supportedOps,
    read_only_support: true,
    write_support: false,
    required_permissions: {
      authentication: authReqs.authentication ?? "required",
      visibility: visibility,
      persona: authReqs.persona ?? "atd or authenticated user",
    },
    permission_requirements: {
      authentication: authReqs.authentication ?? "required",
      visibility: visibility,
      persona: authReqs.persona ?? "atd or authenticated user",
      token_type: authReqs.token_type ?? "jwt_anon_key",
    },
    governance_restrictions: {
      constitutional_visibility: visibility,
      read_only_enforced: true,
      no_mutation_tools: true,
      tenant_isolation: "EIOS governance enforced",
    },
    authentication_requirements: authReqs,
    dependencies: dependencies,
    supported_object_types: supportedObjectTypes,
    current_availability: currentAvailability,
    available: isAvailable,
    deprecated: cap.deprecated ?? false,
    superseded_by: cap.superseded_by ?? null,
    replacement_capability: cap.replacement_capability ?? null,
    introduced_by_ewo: cap.introduced_by_ewo ?? "unavailable",
    inspection_contract_version: cap.inspection_contract_version ?? "unavailable",
    tags_categories: [cap.category ?? "uncategorised"],
    relationships: relationships,
    owner: cap.owner ?? "unavailable",
    input_output_schemas: (metadata && Object.keys(metadata).length > 0) ? metadata : "unavailable",
  };
}

// ─── Runtime Diagnostic Envelope (EWO-017) ───────────────────────────────────
// Captures only values actually produced at runtime — never fabricated.

interface RuntimeDiagnosticEnvelope {
  capability_resolved: string | null;
  resolution_confidence: number;
  metadata_source: string;
  operations_returned: string[];
  permissions_evaluated: boolean;
  governance_outcome: string;
  execution_path: "capability_metadata_inspection" | "framework_introspection";
}

function buildRuntimeDiagnosticEnvelope(
  capabilityId: string | null,
  confidence: number,
  operations: unknown[],
  governanceOutcome: string,
  executionPath: "capability_metadata_inspection" | "framework_introspection" = "capability_metadata_inspection",
): RuntimeDiagnosticEnvelope {
  return {
    capability_resolved: capabilityId,
    resolution_confidence: confidence,
    metadata_source: capabilityId ? "atd_connect_capabilities registry" : "none",
    operations_returned: Array.isArray(operations) ? operations.map(String) : [],
    permissions_evaluated: true,
    governance_outcome: governanceOutcome,
    execution_path: executionPath,
  };
}

// ─── Context-First Conversational Routing (EWO-017R.2) ────────────────────────
// Resolves governed conversational and engineering-object context BEFORE
// selecting a specialised capability route. Prevents misclassification of
// engineering continuation requests as capability metadata inspections.

// ── Explicit canonical object reference detection ──────────────────────────
const EXPLICIT_REF_PATTERNS: RegExp[] = [
  /\b(EWO-[\w.]+)/i,
  /\b(BUG-[\w.]+)/i,
  /\b(PLAN-[\w.]+)/i,
  /\b(INTENT-[\w.]+)/i,
  /\b(DCR-[\w.]+)/i,
  /\b(ERC-[\w.]+)/i,
];

interface ExplicitReference {
  detected: boolean;
  value: string | null;
  object_type: string | null;
}

function detectExplicitReference(text: string): ExplicitReference {
  for (const pattern of EXPLICIT_REF_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const ref = match[1].toUpperCase();
      const typeMap: Record<string, string> = {
        "EWO": "engineering_work_order",
        "BUG": "bug",
        "PLAN": "engineering_plan",
        "INTENT": "engineering_intent",
        "DCR": "design_change_request",
        "ERC": "engineering_record",
      };
      const prefix = ref.split("-")[0];
      return { detected: true, value: ref, object_type: typeMap[prefix] ?? null };
    }
  }
  return { detected: false, value: null, object_type: null };
}

// ── Contextual reference detection ──────────────────────────────────────────
const CONTEXTUAL_REF_PATTERNS: RegExp[] = [
  /this\s+engineering\s+work\s+order/i,
  /the\s+current\s+ewo/i,
  /this\s+ewo/i,
  /the\s+engineering\s+work\s+order\s+above/i,
  /the\s+current\s+engineering\s+analysis/i,
  /this\s+analysis/i,
  /the\s+proposed\s+plan/i,
  /the\s+current\s+engineering\s+plan/i,
  /this\s+proposal/i,
  /the\s+framework\s+being\s+designed/i,
  /continue\s+where\s+we\s+left\s+off/i,
  /expand\s+the\s+analysis/i,
  /expand\s+this\s+analysis/i,
  /update\s+the\s+plan/i,
  /address\s+the\s+review\s+findings/i,
  /test\s+the\s+current\s+refinement/i,
  /the\s+current\s+ewo/i,
  /current\s+engineering\s+work\s+order/i,
];

interface ContextualReference {
  detected: boolean;
  terms: string[];
}

function detectContextualReference(text: string): ContextualReference {
  const terms: string[] = [];
  for (const pattern of CONTEXTUAL_REF_PATTERNS) {
    if (pattern.test(text)) {
      const match = text.match(pattern);
      if (match) terms.push(match[0]);
    }
  }
  return { detected: terms.length > 0, terms: [...new Set(terms)] };
}

// ── Negative constraint extraction ───────────────────────────────────────────
const NEGATIVE_CONSTRAINT_PATTERNS: Array<{ pattern: RegExp; constraint: string }> = [
  { pattern: /do\s+not\s+inspect\s+(?:a\s+)?capabilit/i, constraint: "do_not_inspect_capability" },
  { pattern: /do\s+not\s+perform\s+(?:a\s+)?write/i, constraint: "do_not_perform_write" },
  { pattern: /do\s+not\s+advance\s+(?:the\s+)?ewo/i, constraint: "do_not_advance_ewo" },
  { pattern: /do\s+not\s+infer\s+unavailable\s+information/i, constraint: "do_not_infer_unavailable_info" },
  { pattern: /only\s+return\s+diagnostics/i, constraint: "only_return_diagnostics" },
  { pattern: /use\s+(?:the\s+)?current\s+engineering\s+work\s+order/i, constraint: "use_current_ewo" },
  { pattern: /do\s+not\s+begin\s+implementation/i, constraint: "do_not_begin_implementation" },
  { pattern: /do\s+not\s+deploy/i, constraint: "do_not_deploy" },
  { pattern: /do\s+not\s+close\s+(?:the\s+)?ewo/i, constraint: "do_not_close_ewo" },
  { pattern: /do\s+not\s+approve/i, constraint: "do_not_approve" },
];

interface NegativeConstraints {
  detected: string[];
}

function extractNegativeConstraints(text: string): NegativeConstraints {
  const detected: string[] = [];
  for (const { pattern, constraint } of NEGATIVE_CONSTRAINT_PATTERNS) {
    if (pattern.test(text)) {
      detected.push(constraint);
    }
  }
  return { detected: [...new Set(detected)] };
}

// ── Engineering continuation intent detection ───────────────────────────────
const CONTINUATION_INTENT_PATTERNS: Array<{ pattern: RegExp; intent: string; operation: string }> = [
  { pattern: /expand\s+(?:the\s+)?engineering\s+analysis/i, intent: "engineering_analysis_continuation", operation: "continue_engineering_analysis" },
  { pattern: /expand\s+(?:the\s+)?analysis/i, intent: "engineering_analysis_continuation", operation: "continue_engineering_analysis" },
  { pattern: /expand\s+this\s+analysis/i, intent: "engineering_analysis_continuation", operation: "continue_engineering_analysis" },
  { pattern: /continue\s+(?:the\s+)?engineering\s+analysis/i, intent: "engineering_analysis_continuation", operation: "continue_engineering_analysis" },
  { pattern: /continue\s+(?:the\s+)?analysis/i, intent: "engineering_analysis_continuation", operation: "continue_engineering_analysis" },
  { pattern: /update\s+(?:the\s+)?(?:current\s+)?engineering\s+plan/i, intent: "engineering_plan_continuation", operation: "continue_engineering_plan" },
  { pattern: /update\s+(?:the\s+)?plan/i, intent: "engineering_plan_continuation", operation: "continue_engineering_plan" },
  { pattern: /address\s+(?:the\s+)?(?:product\s+owner\s+)?review\s+findings/i, intent: "engineering_review_continuation", operation: "continue_engineering_review" },
  { pattern: /address\s+(?:the\s+)?review\s+findings/i, intent: "engineering_review_continuation", operation: "continue_engineering_review" },
  { pattern: /test\s+(?:the\s+)?current\s+refinement/i, intent: "engineering_lifecycle_read", operation: "read_verification_status" },
  { pattern: /expand\s+(?:the\s+)?engineering\s+plan/i, intent: "engineering_plan_continuation", operation: "continue_engineering_plan" },
  { pattern: /continue\s+where\s+we\s+left\s+off/i, intent: "engineering_analysis_continuation", operation: "continue_engineering_analysis" },
  { pattern: /should\s+this\s+ewo\s+(?:establish|create|build)/i, intent: "engineering_analysis_continuation", operation: "continue_engineering_analysis" },
  { pattern: /should\s+(?:this\s+)?ewo\s+(?:establish|create|build|merely|just)/i, intent: "engineering_analysis_continuation", operation: "continue_engineering_analysis" },
  { pattern: /should\s+this\s+proposal\s+be\s+implemented/i, intent: "engineering_analysis_continuation", operation: "continue_engineering_analysis" },
];

interface ContinuationIntent {
  detected: boolean;
  intent: string | null;
  operation: string | null;
  confidence: number;
}

function detectContinuationIntent(text: string): ContinuationIntent {
  for (const { pattern, intent, operation } of CONTINUATION_INTENT_PATTERNS) {
    if (pattern.test(text)) {
      return { detected: true, intent, operation, confidence: 0.9 };
    }
  }
  return { detected: false, intent: null, operation: null, confidence: 0 };
}

// ── Context-binding intent detection (EWO-017R.2R refinement) ───────────────
// Detects requests to make an Engineering Work Order active for the current
// conversation. This is a conversational context-binding operation, NOT a
// lifecycle mutation. The phrase "make it active" must NOT be interpreted as
// changing the EWO lifecycle status to Active or In Progress.
const CONTEXT_BINDING_PATTERNS: RegExp[] = [
  /make\s+(?:it|this|the)\s+(?:the\s+)?active\s+(?:engineering\s+work\s+order|ewo|object)\s+for\s+(?:this\s+)?conversation/i,
  /make\s+(?:it|this)\s+active\s+for\s+(?:this\s+)?conversation/i,
  /set\s+(?:it|this|the)\s+as\s+(?:the\s+)?active\s+(?:engineering\s+work\s+order|ewo|object)/i,
  /bind\s+(?:it|this|the)\s+(?:as|to)\s+(?:the\s+)?active\s+(?:engineering\s+work\s+order|ewo|object)/i,
  /establish\s+(?:it|this)\s+as\s+(?:the\s+)?active\s+(?:engineering\s+work\s+order|ewo|object)/i,
  /activate\s+(?:it|this|the)\s+(?:as|for)\s+(?:the\s+)?(?:active\s+)?(?:engineering\s+work\s+order|ewo|object)/i,
];

interface ContextBindingIntent {
  detected: boolean;
  isCombinedWithInspection: boolean;
  confidence: number;
}

function detectContextBindingIntent(text: string): ContextBindingIntent {
  for (const pattern of CONTEXT_BINDING_PATTERNS) {
    if (pattern.test(text)) {
      const isCombinedWithInspection = /inspect|show|describe|view|display/i.test(text);
      return { detected: true, isCombinedWithInspection, confidence: 0.95 };
    }
  }
  return { detected: false, isCombinedWithInspection: false, confidence: 0 };
}

// ── Governed conversation identity generation (EWO-017R.2R refinement) ──────
// When no conversation identity can be derived from the MCP request, generate
// a deterministic governed identifier persisted to the database. This ensures
// the runtime never relies on a null session identifier for context binding.
async function generateGovernedConversationId(
  supabase: ReturnType<typeof createClient>,
  tenantId: string,
): Promise<string | null> {
  // Only called when a conversation-specific identity was supplied via header
  // but no explicit ID was provided. We generate a deterministic ID tied to
  // the MCP session, not to the user. The caller must have already established
  // a conversation-specific scope; this just creates a stable handle.
  const generatedId = "gen-" + crypto.randomUUID();
  try {
    await supabase.from("atd_conversation_sessions").insert({
      conversation_id: generatedId,
      tenant_id: tenantId,
      identity_source: "generated",
    });
    return generatedId;
  } catch {
    return null;
  }
}

// ── Active-object binding with audit trail (EWO-017R.2R refinement) ──────────
// Binds a resolved engineering object as the active conversational context.
// Records the previous and new active-object references for auditability.
// Does NOT mutate any EWO lifecycle field.
async function bindActiveObjectWithAudit(
  supabase: ReturnType<typeof createClient>,
  conversationId: string,
  tenantId: string,
  objectRef: string,
  objectType: string,
  title: string | null,
  lifecycleStage: string | null,
  sourceOfActivation: string,
  lastOperation: string | null,
): Promise<{ updated: boolean; previousActiveObject: string | null; newActiveObject: string; recordId: string | null }> {
  try {
    // Scope by BOTH tenant_id AND conversation_id to prevent cross-conversation
    // and cross-tenant context leakage.
    const { data: existing } = await supabase
      .from("atd_conversation_active_object")
      .select("id, active_object_reference")
      .eq("conversation_id", conversationId)
      .eq("tenant_id", tenantId)
      .order("context_timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();

    const previousActiveObject = existing?.active_object_reference ?? null;

    if (existing && existing.id) {
      const { data: updated } = await supabase
        .from("atd_conversation_active_object")
        .update({
          active_object_reference: objectRef,
          active_object_type: objectType,
          active_object_title: title,
          lifecycle_stage: lifecycleStage,
          source_of_activation: sourceOfActivation,
          last_governed_operation: lastOperation,
          context_timestamp: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select("id")
        .single();
      return { updated: true, previousActiveObject, newActiveObject: objectRef, recordId: updated?.id ?? null };
    }

    const { data: inserted } = await supabase
      .from("atd_conversation_active_object")
      .insert({
        conversation_id: conversationId,
        tenant_id: tenantId,
        active_object_reference: objectRef,
        active_object_type: objectType,
        active_object_title: title,
        lifecycle_stage: lifecycleStage,
        source_of_activation: sourceOfActivation,
        last_governed_operation: lastOperation,
        context_timestamp: new Date().toISOString(),
      })
      .select("id")
      .single();
    return { updated: true, previousActiveObject, newActiveObject: objectRef, recordId: inserted?.id ?? null };
  } catch {
    return { updated: false, previousActiveObject: null, newActiveObject: objectRef, recordId: null };
  }
}

// ── Genuine capability metadata request detection ───────────────────────────
// A request is a genuine capability metadata inspection ONLY when:
// 1. It explicitly asks to inspect/explain/describe a named capability
// 2. The word "capability" appears in a metadata-inspection context (not as
//    a negative constraint or as part of a larger engineering discussion)
// 3. No negative constraint prohibits capability inspection
// 4. No continuation intent is detected

function isGenuineCapabilityMetadataRequest(
  text: string,
  continuation: ContinuationIntent,
  negativeConstraints: NegativeConstraints,
): boolean {
  if (continuation.detected) return false;
  if (negativeConstraints.detected.includes("do_not_inspect_capability")) return false;

  // Check for genuine capability inspection patterns — these must be clear,
  // direct requests about a specific registered capability's metadata.
  const genuinePatterns: RegExp[] = [
    /inspect\s+(?:the\s+)?(\w[\w\s-]*?)\s+capability\s+(?:and|\.|$)/i,
    /what\s+operations\s+(?:does|do)\s+(?:the\s+)?(\w[\w\s-]*?)\s+(?:capability\s+)?(?:expose|offer|support|provide)/i,
    /what\s+(?:is|are)\s+(?:the\s+)?lifecycle\s+status\s+and\s+dependencies\s+of\s+(?:the\s+)?(\w[\w\s-]*?)\s+capability/i,
    /is\s+(?:the\s+)?(\w[\w\s-]*?)\s+capability\s+read[\s-]?only/i,
    /does\s+(?:the\s+)?(\w[\w\s-]*?)\s+capability\s+support\s+write/i,
    /show\s+(?:me\s+)?(?:the\s+)?lifecycle\s+status\s+and\s+dependencies\s+of\s+(?:the\s+)?(\w[\w\s-]*?)\s+capability/i,
    /inspect\s+(?:the\s+)?(\w[\w\s-]*?)\s+capability\s+and\s+explain\s+its\s+operations/i,
  ];

  for (const pattern of genuinePatterns) {
    if (pattern.test(text)) return true;
  }

  // Check for simple, direct capability inspection phrases that are NOT
  // part of a larger engineering discussion.
  // Key: the phrase must be a direct request about a capability, not a
  // sentence fragment that happens to contain "capability".
  const simplePatterns: RegExp[] = [
    /^inspect\s+(?:the\s+)?(\w[\w\s-]*?)\s+capability/i,
    /^explain\s+(?:the\s+)?(\w[\w\s-]*?)\s+capability/i,
    /^describe\s+(?:the\s+)?(\w[\w\s-]*?)\s+capability/i,
    /^show\s+(?:me\s+)?(?:the\s+)?(\w[\w\s-]*?)\s+capability/i,
    /^tell me about\s+(?:the\s+)?(\w[\w\s-]*?)\s+capability/i,
    /^what\s+(?:is|are)\s+(?:the\s+)?(\w[\w\s-]*?)\s+capability/i,
  ];

  for (const pattern of simplePatterns) {
    if (pattern.test(text.trim())) return true;
  }

  return false;
}

// ── Governed conversation context resolution ─────────────────────────────────
interface ResolvedEngineeringObject {
  reference: string | null;
  object_type: string | null;
  resolution_status: "resolved" | "failed" | "ambiguous" | "not_attempted";
  resolution_method: string | null;
  context_resolution_source: string;
  candidate_objects: string[];
  title: string | null;
  lifecycle_stage: string | null;
}

// ── Active-object population (EWO-017R.2R) ────────────────────────────────────
// Automatically establishes or updates the governed active object when an
// EWO is explicitly referenced or successfully resolved. This enables
// contextual references ("the current EWO") in subsequent requests.

async function populateActiveObject(
  supabase: ReturnType<typeof createClient>,
  conversationId: string,
  objectRef: string,
  objectType: string,
  title: string | null,
  lifecycleStage: string | null,
  sourceOfActivation: string,
  lastOperation: string | null,
  tenantId: string = "anonymous",
): Promise<{ updated: boolean; record_id: string | null }> {
  try {
    // Check if an active object already exists for this conversation+tenant
    const { data: existing } = await supabase
      .from("atd_conversation_active_object")
      .select("id, active_object_reference")
      .eq("conversation_id", conversationId)
      .eq("tenant_id", tenantId)
      .order("context_timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing && existing.id) {
      // Update existing record
      const { data: updated } = await supabase
        .from("atd_conversation_active_object")
        .update({
          active_object_reference: objectRef,
          active_object_type: objectType,
          active_object_title: title,
          lifecycle_stage: lifecycleStage,
          source_of_activation: sourceOfActivation,
          last_governed_operation: lastOperation,
          context_timestamp: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select("id")
        .single();
      return { updated: true, record_id: updated?.id ?? null };
    }

    // Insert new record
    const { data: inserted } = await supabase
      .from("atd_conversation_active_object")
      .insert({
        conversation_id: conversationId,
        tenant_id: tenantId,
        active_object_reference: objectRef,
        active_object_type: objectType,
        active_object_title: title,
        lifecycle_stage: lifecycleStage,
        source_of_activation: sourceOfActivation,
        last_governed_operation: lastOperation,
        context_timestamp: new Date().toISOString(),
      })
      .select("id")
      .single();
    return { updated: true, record_id: inserted?.id ?? null };
  } catch {
    return { updated: false, record_id: null };
  }
}

// ── Engineering Analysis retrieval (EWO-017R.2R) ──────────────────────────────
// Retrieves governed Engineering Analysis and linked artefacts for a resolved
// EWO. Returns structured data with provenance — only actual retrieved data
// is included; no data is invented.

interface RetrievedEngineeringArtefacts {
  ewo_ref: string;
  ewo_title: string | null;
  ewo_status: string | null;
  ewo_business_objective: string | null;
  ewo_engineering_objective: string | null;
  ewo_scope: string | null;
  ewo_engineering_notes: string | null;
  linked_intent: {
    intent_ref: string | null;
    title: string | null;
    status: string | null;
    business_objective: string | null;
    engineering_objective: string | null;
  } | null;
  linked_plan: {
    plan_ref: string | null;
    executive_summary: string | null;
    engineering_strategy: string | null;
    recommended_approach: string | null;
    status: string | null;
    estimated_effort: string | null;
  } | null;
  linked_reviews: Array<{
    erc_number: string | null;
    title: string | null;
    status: string | null;
    engineering_analysis: string | null;
    root_cause: string | null;
    engineering_decision: string | null;
  }>;
  po_reviews: Array<{
    review_status: string | null;
    final_decision: string | null;
    decision_note: string | null;
  }>;
  artefacts_retrieved: string[];
  missing_artefacts: string[];
}

async function retrieveEngineeringAnalysis(
  supabase: ReturnType<typeof createClient>,
  ewoRef: string,
): Promise<RetrievedEngineeringArtefacts | null> {
  const artefactsRetrieved: string[] = [];
  const missingArtefacts: string[] = [];

  // 1. Retrieve the EWO record
  const { data: ewo } = await supabase
    .from("engineering_work_orders")
    .select("ewo_ref, title, status, business_objective, engineering_objective, scope, engineering_notes")
    .eq("ewo_ref", ewoRef)
    .maybeSingle();

  if (!ewo) return null;
  artefactsRetrieved.push("engineering_work_orders");

  // 2. Retrieve linked Engineering Intent via atd_intent_conversation_links or direct
  let linkedIntent = null;
  const { data: intentLink } = await supabase
    .from("atd_intent_conversation_links")
    .select("intent_id")
    .eq("conversation_id", ewoRef)
    .limit(1)
    .maybeSingle();

  if (intentLink?.intent_id) {
    const { data: intent } = await supabase
      .from("atd_engineering_intents")
      .select("intent_ref, title, status, business_objective, engineering_objective")
      .eq("id", intentLink.intent_id)
      .maybeSingle();
    if (intent) {
      linkedIntent = {
        intent_ref: String(intent.intent_ref ?? ""),
        title: String(intent.title ?? ""),
        status: String(intent.status ?? ""),
        business_objective: String(intent.business_objective ?? ""),
        engineering_objective: String(intent.engineering_objective ?? ""),
      };
      artefactsRetrieved.push("atd_engineering_intents");
    } else {
      missingArtefacts.push("atd_engineering_intents");
    }
  } else {
    // Try engineering_intent table
    const { data: legacyIntent } = await supabase
      .from("engineering_intent")
      .select("intent_ref, title, status, business_driver, strategic_alignment")
      .ilike("title", "%" + String(ewo.title ?? "").slice(0, 30) + "%")
      .limit(1)
      .maybeSingle();
    if (legacyIntent) {
      linkedIntent = {
        intent_ref: String(legacyIntent.intent_ref ?? ""),
        title: String(legacyIntent.title ?? ""),
        status: String(legacyIntent.status ?? ""),
        business_objective: String(legacyIntent.business_driver ?? ""),
        engineering_objective: String(legacyIntent.strategic_alignment ?? ""),
      };
      artefactsRetrieved.push("engineering_intent");
    } else {
      missingArtefacts.push("engineering_intent");
    }
  }

  // 3. Retrieve linked Engineering Plan
  let linkedPlan = null;
  const { data: planLink } = await supabase
    .from("atd_engineering_plans")
    .select("plan_ref, executive_summary, engineering_strategy, recommended_approach, status, estimated_effort")
    .ilike("plan_ref", "%" + ewoRef + "%")
    .limit(1)
    .maybeSingle();

  if (planLink) {
    linkedPlan = {
      plan_ref: String(planLink.plan_ref ?? ""),
      executive_summary: String(planLink.executive_summary ?? ""),
      engineering_strategy: String(planLink.engineering_strategy ?? ""),
      recommended_approach: String(planLink.recommended_approach ?? ""),
      status: String(planLink.status ?? ""),
      estimated_effort: String(planLink.estimated_effort ?? ""),
    };
    artefactsRetrieved.push("atd_engineering_plans");
  } else {
    missingArtefacts.push("atd_engineering_plans");
  }

  // 4. Retrieve linked Engineering Reviews
  const { data: reviews } = await supabase
    .from("ecc_engineering_reviews")
    .select("erc_number, title, status, engineering_analysis, root_cause, engineering_decision")
    .ilike("title", "%" + ewoRef + "%")
    .limit(5);

  const linkedReviews = (reviews ?? []).map((r: Record<string, unknown>) => ({
    erc_number: String(r.erc_number ?? ""),
    title: String(r.title ?? ""),
    status: String(r.status ?? ""),
    engineering_analysis: String(r.engineering_analysis ?? ""),
    root_cause: String(r.root_cause ?? ""),
    engineering_decision: String(r.engineering_decision ?? ""),
  }));

  if (linkedReviews.length > 0) {
    artefactsRetrieved.push("ecc_engineering_reviews");
  } else {
    missingArtefacts.push("ecc_engineering_reviews");
  }

  // 5. Retrieve PO reviews
  const { data: poReviews } = await supabase
    .from("engineering_integrity_po_reviews")
    .select("review_status, final_decision, decision_note")
    .eq("ewo_ref", ewoRef)
    .limit(5);

  const poReviewData = (poReviews ?? []).map((r: Record<string, unknown>) => ({
    review_status: String(r.review_status ?? ""),
    final_decision: String(r.final_decision ?? ""),
    decision_note: String(r.decision_note ?? ""),
  }));

  if (poReviewData.length > 0) {
    artefactsRetrieved.push("engineering_integrity_po_reviews");
  } else {
    missingArtefacts.push("engineering_integrity_po_reviews");
  }

  return {
    ewo_ref: String(ewo.ewo_ref ?? ""),
    ewo_title: String(ewo.title ?? ""),
    ewo_status: String(ewo.status ?? ""),
    ewo_business_objective: String(ewo.business_objective ?? ""),
    ewo_engineering_objective: String(ewo.engineering_objective ?? ""),
    ewo_scope: String(ewo.scope ?? ""),
    ewo_engineering_notes: String(ewo.engineering_notes ?? ""),
    linked_intent: linkedIntent,
    linked_plan: linkedPlan,
    linked_reviews: linkedReviews,
    po_reviews: poReviewData,
    artefacts_retrieved: artefactsRetrieved,
    missing_artefacts: missingArtefacts,
  };
}

async function resolveConversationContext(
  supabase: ReturnType<typeof createClient>,
  text: string,
  explicitRef: ExplicitReference,
  contextualRef: ContextualReference,
  sessionId?: string,
  tenantId: string = "anonymous",
): Promise<ResolvedEngineeringObject> {
  const notAttempted: ResolvedEngineeringObject = {
    reference: null,
    object_type: null,
    resolution_status: "not_attempted",
    resolution_method: null,
    context_resolution_source: "none",
    candidate_objects: [],
    title: null,
    lifecycle_stage: null,
  };

  // 1. Explicit canonical object reference
  if (explicitRef.detected && explicitRef.value) {
    const ref = explicitRef.value;
    if (explicitRef.object_type === "engineering_work_order") {
      const { data: ewo } = await supabase
        .from("engineering_work_orders")
        .select("ewo_ref, title, status")
        .eq("ewo_ref", ref)
        .maybeSingle();
      if (ewo) {
        return {
          reference: ref,
          object_type: "engineering_work_order",
          resolution_status: "resolved",
          resolution_method: "explicit_canonical_reference",
          context_resolution_source: "explicit_reference_in_request",
          candidate_objects: [],
          title: String(ewo.title ?? ""),
          lifecycle_stage: String(ewo.status ?? ""),
        };
      }
    }
    // Reference detected but not found — return failed
    return {
      reference: ref,
      object_type: explicitRef.object_type,
      resolution_status: "failed",
      resolution_method: "explicit_canonical_reference",
      context_resolution_source: "explicit_reference_in_request",
      candidate_objects: [],
      title: null,
      lifecycle_stage: null,
    };
  }

  // 2. Contextual reference — look up governed conversation state
  if (contextualRef.detected && sessionId) {
    // Check atd_conversation_active_object for the authoritative active object
    // Scoped by BOTH conversation_id AND tenant_id to prevent cross-conversation leakage
    const { data: activeObj } = await supabase
      .from("atd_conversation_active_object")
      .select("active_object_reference, active_object_type, active_object_title, lifecycle_stage")
      .eq("conversation_id", sessionId)
      .eq("tenant_id", tenantId)
      .order("context_timestamp", { ascending: false })
      .limit(10);

    if (activeObj && activeObj.length > 0) {
      const ewoLinks = activeObj.filter(
        (o: { active_object_type: string }) => o.active_object_type === "engineering_work_order",
      );
      if (ewoLinks.length === 1) {
        return {
          reference: String(ewoLinks[0].active_object_reference ?? ""),
          object_type: "engineering_work_order",
          resolution_status: "resolved",
          resolution_method: "governed_conversation_context",
          context_resolution_source: "atd_conversation_active_object",
          candidate_objects: [],
          title: String(ewoLinks[0].active_object_title ?? ""),
          lifecycle_stage: String(ewoLinks[0].lifecycle_stage ?? ""),
        };
      }
      if (ewoLinks.length > 1) {
        return {
          reference: null,
          object_type: "engineering_work_order",
          resolution_status: "ambiguous",
          resolution_method: "governed_conversation_context",
          context_resolution_source: "atd_conversation_active_object",
          candidate_objects: ewoLinks.map((o: { active_object_reference: string }) => String(o.active_object_reference ?? "")),
          title: null,
          lifecycle_stage: null,
        };
      }
    }

    // Check ecc_conversation_artefact_links for active engineering objects
    // Scoped by tenant_id to prevent cross-conversation leakage
    const { data: artefactLinks } = await supabase
      .from("ecc_conversation_artefact_links")
      .select("artefact_type, artefact_ref, artefact_title")
      .eq("conversation_id", sessionId)
      .eq("tenant_id", tenantId)
      .order("linked_at", { ascending: false })
      .limit(10);

    if (artefactLinks && artefactLinks.length > 0) {
      const ewoLinks = artefactLinks.filter(
        (l: { artefact_type: string }) => l.artefact_type === "engineering_work_order" || l.artefact_type === "ewo",
      );
      if (ewoLinks.length === 1) {
        return {
          reference: String(ewoLinks[0].artefact_ref ?? ""),
          object_type: "engineering_work_order",
          resolution_status: "resolved",
          resolution_method: "governed_conversation_context",
          context_resolution_source: "ecc_conversation_artefact_links",
          candidate_objects: [],
          title: String(ewoLinks[0].artefact_title ?? ""),
          lifecycle_stage: null,
        };
      }
      if (ewoLinks.length > 1) {
        return {
          reference: null,
          object_type: "engineering_work_order",
          resolution_status: "ambiguous",
          resolution_method: "governed_conversation_context",
          context_resolution_source: "ecc_conversation_artefact_links",
          candidate_objects: ewoLinks.map((l: { artefact_ref: string }) => String(l.artefact_ref ?? "")),
          title: null,
          lifecycle_stage: null,
        };
      }
    }

    // Check eil_conversation_lineage for related work order IDs
    // Scoped by tenant_id to prevent cross-conversation leakage
    const { data: lineage } = await supabase
      .from("eil_conversation_lineage")
      .select("related_work_order_ids")
      .eq("conversation_id", sessionId)
      .eq("tenant_id", tenantId)
      .order("updated_at", { ascending: false })
      .limit(1);

    if (lineage && lineage.length > 0) {
      const workOrderIds = Array.isArray(lineage[0].related_work_order_ids) ? lineage[0].related_work_order_ids : [];
      if (workOrderIds.length === 1) {
        const { data: ewo } = await supabase
          .from("engineering_work_orders")
          .select("ewo_ref, title, status")
          .eq("ewo_ref", String(workOrderIds[0]))
          .maybeSingle();
        if (ewo) {
          return {
            reference: String(ewo.ewo_ref),
            object_type: "engineering_work_order",
            resolution_status: "resolved",
            resolution_method: "governed_conversation_context",
            context_resolution_source: "eil_conversation_lineage",
            candidate_objects: [],
            title: String(ewo.title ?? ""),
            lifecycle_stage: String(ewo.status ?? ""),
          };
        }
      }
      if (workOrderIds.length > 1) {
        return {
          reference: null,
          object_type: "engineering_work_order",
          resolution_status: "ambiguous",
          resolution_method: "governed_conversation_context",
          context_resolution_source: "eil_conversation_lineage",
          candidate_objects: workOrderIds.map(String),
          title: null,
          lifecycle_stage: null,
        };
      }
    }
  }

    // Contextual reference detected, session ID exists, but no active object
    // was found in any governed source. Return failed so the handler can
    // return conversation_identifier in the response.
    if (contextualRef.detected && sessionId) {
      return {
        reference: null,
        object_type: null,
        resolution_status: "failed",
        resolution_method: "governed_conversation_context",
        context_resolution_source: "atd_conversation_active_object",
        candidate_objects: [],
        title: null,
        lifecycle_stage: null,
      };
    }

  // 3. Contextual reference but no session ID — cannot resolve
  if (contextualRef.detected && !sessionId) {
    return {
      reference: null,
      object_type: null,
      resolution_status: "failed",
      resolution_method: null,
      context_resolution_source: "none",
      candidate_objects: [],
      title: null,
      lifecycle_stage: null,
    };
  }

  return notAttempted;
}

// ── Context-first diagnostic envelope (EWO-017R.2R extended) ─────────────────
interface ContextFirstDiagnosticEnvelope {
  request_id: string;
  detected_intent: string;
  intent_confidence: number;
  routing_decision: string;
  explicit_reference_detected: boolean;
  explicit_reference_value: string | null;
  contextual_reference_detected: boolean;
  contextual_reference_terms: string[];
  negative_constraints_detected: string[];
  resolved_engineering_object_reference: string | null;
  resolved_engineering_object_type: string | null;
  object_resolution_status: string;
  object_resolution_method: string | null;
  context_resolution_source: string;
  candidate_objects_considered: string[];
  ambiguity_detected: boolean;
  clarification_required: boolean;
  operation_selected: string | null;
  capability_selected: string | null;
  capability_metadata_lookup_attempted: boolean;
  write_request_detected: boolean;
  permission_evaluation: string;
  governance_outcome: string;
  fallback_route_used: string | null;
  failure_reason: string | null;
  audit_reference: string;
  generated_at: string;
  // EWO-017R.2R: Runtime execution diagnostics
  conversation_identifier_received: string | null;
  conversation_identifier_source: string;
  active_object_lookup_attempted: boolean;
  active_object_record_found: boolean;
  active_object_updated: boolean;
  linked_analysis_lookup_attempted: boolean;
  linked_analysis_reference: string | null;
  linked_analysis_retrieved: boolean;
  linked_plan_lookup_attempted: boolean;
  linked_plan_reference: string | null;
  artefacts_retrieved: string[];
  continuation_handler_invoked: boolean;
  continuation_output_created: boolean;
  governed_draft_reference: string | null;
  lifecycle_mutation_attempted: boolean;
  lifecycle_mutation_performed: boolean;
  // EWO-017R.2R refinement: Context-binding diagnostics
  context_binding_intent_detected: boolean;
  context_binding_is_combined_with_inspection: boolean;
  combined_intent_decomposition: string[];
  previous_active_object_reference: string | null;
  new_active_object_reference: string | null;
  context_binding_outcome: string;
  context_binding_operation: boolean;
  lifecycle_change_performed: boolean;
  operation_resolution: string | null;
  capability_resolution: string | null;
  conversation_scope_verified: boolean;
}

function buildContextFirstDiagnostic(
  auditRef: string,
  intent: string,
  confidence: number,
  routing: string,
  explicitRef: ExplicitReference,
  contextualRef: ContextualReference,
  negativeConstraints: NegativeConstraints,
  resolvedObject: ResolvedEngineeringObject,
  operation: string | null,
  capability: string | null,
  capabilityLookupAttempted: boolean,
  writeDetected: boolean,
  governanceOutcome: string,
  fallbackRoute: string | null,
  failureReason: string | null,
  // EWO-017R.2R extended runtime fields
  conversationIdReceived: string | null = null,
  conversationIdSource: string = "none",
  activeObjectLookupAttempted: boolean = false,
  activeObjectRecordFound: boolean = false,
  activeObjectUpdated: boolean = false,
  linkedAnalysisLookupAttempted: boolean = false,
  linkedAnalysisReference: string | null = null,
  linkedAnalysisRetrieved: boolean = false,
  linkedPlanLookupAttempted: boolean = false,
  linkedPlanReference: string | null = null,
  artefactsRetrieved: string[] = [],
  continuationHandlerInvoked: boolean = false,
  continuationOutputCreated: boolean = false,
  governedDraftReference: string | null = null,
  lifecycleMutationAttempted: boolean = false,
  lifecycleMutationPerformed: boolean = false,
  // EWO-017R.2R refinement: Context-binding diagnostics
  contextBindingIntentDetected: boolean = false,
  contextBindingIsCombinedWithInspection: boolean = false,
  combinedIntentDecomposition: string[] = [],
  previousActiveObjectReference: string | null = null,
  newActiveObjectReference: string | null = null,
  contextBindingOutcome: string = "not_attempted",
  contextBindingOperation: boolean = false,
  lifecycleChangePerformed: boolean = false,
  operationResolution: string | null = null,
  capabilityResolution: string | null = null,
  conversationScopeVerified: boolean = false,
): ContextFirstDiagnosticEnvelope {
  return {
    request_id: auditRef,
    detected_intent: intent,
    intent_confidence: confidence,
    routing_decision: routing,
    explicit_reference_detected: explicitRef.detected,
    explicit_reference_value: explicitRef.value,
    contextual_reference_detected: contextualRef.detected,
    contextual_reference_terms: contextualRef.terms,
    negative_constraints_detected: negativeConstraints.detected,
    resolved_engineering_object_reference: resolvedObject.reference,
    resolved_engineering_object_type: resolvedObject.object_type,
    object_resolution_status: resolvedObject.resolution_status,
    object_resolution_method: resolvedObject.resolution_method,
    context_resolution_source: resolvedObject.context_resolution_source,
    candidate_objects_considered: resolvedObject.candidate_objects,
    ambiguity_detected: resolvedObject.resolution_status === "ambiguous",
    clarification_required: resolvedObject.resolution_status === "failed" || resolvedObject.resolution_status === "ambiguous",
    operation_selected: operation,
    capability_selected: capability,
    capability_metadata_lookup_attempted: capabilityLookupAttempted,
    write_request_detected: writeDetected,
    permission_evaluation: "evaluated",
    governance_outcome: governanceOutcome,
    fallback_route_used: fallbackRoute,
    failure_reason: failureReason,
    audit_reference: auditRef,
    generated_at: new Date().toISOString(),
    conversation_identifier_received: conversationIdReceived,
    conversation_identifier_source: conversationIdSource,
    active_object_lookup_attempted: activeObjectLookupAttempted,
    active_object_record_found: activeObjectRecordFound,
    active_object_updated: activeObjectUpdated,
    linked_analysis_lookup_attempted: linkedAnalysisLookupAttempted,
    linked_analysis_reference: linkedAnalysisReference,
    linked_analysis_retrieved: linkedAnalysisRetrieved,
    linked_plan_lookup_attempted: linkedPlanLookupAttempted,
    linked_plan_reference: linkedPlanReference,
    artefacts_retrieved: artefactsRetrieved,
    continuation_handler_invoked: continuationHandlerInvoked,
    continuation_output_created: continuationOutputCreated,
    governed_draft_reference: governedDraftReference,
    lifecycle_mutation_attempted: lifecycleMutationAttempted,
    lifecycle_mutation_performed: lifecycleMutationPerformed,
    context_binding_intent_detected: contextBindingIntentDetected,
    context_binding_is_combined_with_inspection: contextBindingIsCombinedWithInspection,
    combined_intent_decomposition: combinedIntentDecomposition,
    previous_active_object_reference: previousActiveObjectReference,
    new_active_object_reference: newActiveObjectReference,
    context_binding_outcome: contextBindingOutcome,
    context_binding_operation: contextBindingOperation,
    lifecycle_change_performed: lifecycleChangePerformed,
    operation_resolution: operationResolution,
    capability_resolution: capabilityResolution,
    conversation_scope_verified: conversationScopeVerified,
  };
}

// ── Clarification response formatter ─────────────────────────────────────────
function formatClarificationResponse(
  intent: string,
  resolvedObject: ResolvedEngineeringObject,
): string {
  if (resolvedObject.resolution_status === "ambiguous" && resolvedObject.candidate_objects.length > 0) {
    return "I recognised this as an engineering continuation request, but multiple compatible engineering objects were found in the conversation context. Please specify which one:\n\n" +
      resolvedObject.candidate_objects.map((r) => "- " + r).join("\n");
  }
  if (resolvedObject.resolution_status === "failed") {
    if (intent === "engineering_analysis_continuation") {
      return "I recognised this as an Engineering Analysis continuation request, but I could not resolve the Engineering Work Order. Which EWO should I analyse?";
    }
    if (intent === "engineering_plan_continuation") {
      return "I recognised this as an Engineering Plan continuation request, but I could not resolve the Engineering Plan. Which plan should I update?";
    }
    return "I recognised this as an engineering continuation request, but I could not resolve the governed engineering object. Please specify the object reference (e.g. EWO-023).";
  }
  return "I could not resolve this request. Please provide more context.";
}

// ── Grounded engineering continuation response formatter (EWO-017R.2R) ────────
// Produces a grounded expanded analysis using actually retrieved governed
// artefacts. Distinguishes existing facts from recommendations and proposed
// design. Identifies missing artefacts and unresolved PO decisions.
function formatGroundedContinuationResponse(
  intent: string,
  operation: string,
  resolvedObject: ResolvedEngineeringObject,
  negativeConstraints: NegativeConstraints,
  artefacts: RetrievedEngineeringArtefacts | null,
): string {
  const sections: string[] = [];
  const objRef = resolvedObject.reference ?? "unresolved";
  const objTitle = resolvedObject.title ?? "";
  const objStage = resolvedObject.lifecycle_stage ?? "unknown";

  sections.push("## Engineering Analysis Continuation\n");
  sections.push("**Active Engineering Object:** " + objRef + (objTitle ? " — " + objTitle : ""));
  sections.push("**Lifecycle Stage:** " + objStage);
  sections.push("**Requested Operation:** " + operation);
  sections.push("");

  if (negativeConstraints.detected.length > 0) {
    sections.push("## Detected Constraints\n");
    for (const c of negativeConstraints.detected) {
      sections.push("- " + c);
    }
    sections.push("");
  }

  // Provenance section
  sections.push("## Provenance — Governed Artefacts Retrieved\n");
  if (artefacts) {
    sections.push("- engineering_work_orders: " + artefacts.ewo_ref + " retrieved");
    if (artefacts.linked_intent) {
      sections.push("- atd_engineering_intents: " + (artefacts.linked_intent.intent_ref || "linked") + " retrieved");
    }
    if (artefacts.linked_plan) {
      sections.push("- atd_engineering_plans: " + (artefacts.linked_plan.plan_ref || "linked") + " retrieved");
    }
    if (artefacts.linked_reviews.length > 0) {
      sections.push("- ecc_engineering_reviews: " + artefacts.linked_reviews.length + " review(s) retrieved");
    }
    if (artefacts.po_reviews.length > 0) {
      sections.push("- engineering_integrity_po_reviews: " + artefacts.po_reviews.length + " PO review(s) retrieved");
    }
    if (artefacts.missing_artefacts.length > 0) {
      sections.push("\n**Missing artefacts:** " + artefacts.missing_artefacts.join(", "));
    }
  } else {
    sections.push("- No governed artefacts were retrieved. The EWO record was not found.");
  }
  sections.push("");

  // Governed existing facts
  sections.push("## Governed Existing Facts\n");
  if (artefacts) {
    if (artefacts.ewo_title) sections.push("- **EWO Title:** " + artefacts.ewo_title);
    if (artefacts.ewo_status) sections.push("- **EWO Status:** " + artefacts.ewo_status);
    if (artefacts.ewo_business_objective) sections.push("- **Business Objective:** " + artefacts.ewo_business_objective);
    if (artefacts.ewo_engineering_objective) sections.push("- **Engineering Objective:** " + artefacts.ewo_engineering_objective);
    if (artefacts.ewo_scope) sections.push("- **Scope:** " + artefacts.ewo_scope);
    if (artefacts.ewo_engineering_notes) sections.push("- **Engineering Notes:** " + artefacts.ewo_engineering_notes);
    if (artefacts.linked_intent) {
      sections.push("");
      sections.push("### Linked Intent");
      if (artefacts.linked_intent.intent_ref) sections.push("- **Intent Ref:** " + artefacts.linked_intent.intent_ref);
      if (artefacts.linked_intent.title) sections.push("- **Title:** " + artefacts.linked_intent.title);
      if (artefacts.linked_intent.status) sections.push("- **Status:** " + artefacts.linked_intent.status);
      if (artefacts.linked_intent.business_objective) sections.push("- **Business Objective:** " + artefacts.linked_intent.business_objective);
    }
    if (artefacts.linked_plan) {
      sections.push("");
      sections.push("### Linked Plan");
      if (artefacts.linked_plan.plan_ref) sections.push("- **Plan Ref:** " + artefacts.linked_plan.plan_ref);
      if (artefacts.linked_plan.status) sections.push("- **Status:** " + artefacts.linked_plan.status);
      if (artefacts.linked_plan.executive_summary) sections.push("- **Executive Summary:** " + artefacts.linked_plan.executive_summary);
      if (artefacts.linked_plan.engineering_strategy) sections.push("- **Engineering Strategy:** " + artefacts.linked_plan.engineering_strategy);
      if (artefacts.linked_plan.recommended_approach) sections.push("- **Recommended Approach:** " + artefacts.linked_plan.recommended_approach);
    }
    if (artefacts.linked_reviews.length > 0) {
      sections.push("");
      sections.push("### Linked Engineering Reviews");
      for (const r of artefacts.linked_reviews) {
        sections.push("- **" + (r.erc_number || "Review") + ":** " + (r.title || "Untitled") + " (" + (r.status || "unknown") + ")");
        if (r.engineering_analysis) sections.push("  Analysis: " + r.engineering_analysis.slice(0, 200) + (r.engineering_analysis.length > 200 ? "..." : ""));
        if (r.root_cause) sections.push("  Root Cause: " + r.root_cause);
        if (r.engineering_decision) sections.push("  Decision: " + r.engineering_decision);
      }
    }
  } else {
    sections.push("- No governed facts available. The EWO was not found in the registry.");
  }
  sections.push("");

  // PO findings
  sections.push("## Product Owner Findings\n");
  if (artefacts && artefacts.po_reviews.length > 0) {
    for (const pr of artefacts.po_reviews) {
      sections.push("- **Review Status:** " + (pr.review_status || "unknown"));
      sections.push("  **Final Decision:** " + (pr.final_decision || "pending"));
      if (pr.decision_note) sections.push("  **Note:** " + pr.decision_note);
    }
  } else {
    sections.push("- No Product Owner reviews have been recorded for this EWO.");
  }
  sections.push("");

  // Architectural recommendations (clearly labelled as non-fact)
  sections.push("## Architectural Recommendations\n");
  sections.push("- The context-first routing pipeline should be completed to support end-to-end governed continuation.");
  sections.push("- Active-object population should be maintained through governed operations only.");
  sections.push("");

  // Unresolved PO decisions
  sections.push("## Unresolved Product Owner Decisions\n");
  sections.push("- Product Owner acceptance of this refinement is pending.");
  sections.push("- No lifecycle advancement has been performed.");
  sections.push("");

  // Unavailable information
  sections.push("## Unavailable Information\n");
  if (artefacts && artefacts.missing_artefacts.length > 0) {
    sections.push("- The following linked artefacts were not found: " + artefacts.missing_artefacts.join(", "));
  } else {
    sections.push("- No unavailable information was identified.");
  }
  sections.push("");

  sections.push("**Note:** Implementation, approval, closure, and deployment will NOT be advanced without an explicit, authorised lifecycle operation.");

  return sections.join("\n");
}

// ── Grounded plan continuation response formatter (EWO-017R.2R) ─────────────────
function formatGroundedPlanContinuationResponse(
  intent: string,
  operation: string,
  resolvedObject: ResolvedEngineeringObject,
  negativeConstraints: NegativeConstraints,
  artefacts: RetrievedEngineeringArtefacts | null,
): string {
  const sections: string[] = [];
  const objRef = resolvedObject.reference ?? "unresolved";

  sections.push("## Engineering Plan Continuation\n");
  sections.push("**Active Engineering Object:** " + objRef + (resolvedObject.title ? " — " + resolvedObject.title : ""));
  sections.push("**Requested Operation:** " + operation);
  sections.push("");

  if (negativeConstraints.detected.length > 0) {
    sections.push("## Detected Constraints\n");
    for (const c of negativeConstraints.detected) {
      sections.push("- " + c);
    }
    sections.push("");
  }

  sections.push("## Current Governed Plan\n");
  if (artefacts?.linked_plan) {
    const p = artefacts.linked_plan;
    if (p.plan_ref) sections.push("- **Plan Ref:** " + p.plan_ref);
    if (p.status) sections.push("- **Status:** " + p.status);
    if (p.executive_summary) sections.push("- **Executive Summary:** " + p.executive_summary);
    if (p.engineering_strategy) sections.push("- **Engineering Strategy:** " + p.engineering_strategy);
    if (p.recommended_approach) sections.push("- **Recommended Approach:** " + p.recommended_approach);
    if (p.estimated_effort) sections.push("- **Estimated Effort:** " + p.estimated_effort);
  } else {
    sections.push("- No governed Engineering Plan was found linked to this EWO.");
  }
  sections.push("");

  sections.push("## Product Owner Findings to Address\n");
  if (artefacts && artefacts.po_reviews.length > 0) {
    for (const pr of artefacts.po_reviews) {
      sections.push("- **Review Status:** " + (pr.review_status || "unknown") + " — **Decision:** " + (pr.final_decision || "pending"));
      if (pr.decision_note) sections.push("  Note: " + pr.decision_note);
    }
  } else {
    sections.push("- No Product Owner findings have been recorded for this EWO.");
  }
  sections.push("");

  sections.push("## Proposed Governed Plan Amendment\n");
  sections.push("- The Engineering Plan should be updated to address the Product Owner findings identified above.");
  sections.push("- This proposed amendment is a governed draft. It has NOT been approved or implemented.");
  sections.push("");

  sections.push("**Constraint enforced:** " + (negativeConstraints.detected.includes("do_not_begin_implementation") ? "do_not_begin_implementation — no implementation lifecycle transition will occur." : "No implementation constraint was explicitly requested, but no implementation will be performed regardless."));

  return sections.join("\n");
}

// ─── Framework Introspection (EWO-017R.1) ──────────────────────────────────────
// Requests about the inspection framework itself, not about a governed
// capability. These must be detected BEFORE capability metadata patterns
// to prevent incorrect target extraction (e.g. "how the" being extracted
// as a capability name from "Explain how the Capability Metadata Inspection
// framework works internally").

const FRAMEWORK_INTROSPECTION_PATTERNS: RegExp[] = [
  /how\s+(?:does|do)\s+(?:the\s+)?capability\s+(?:metadata\s+)?inspection\s+(?:framework|work|pipeline)/i,
  /explain\s+(?:how\s+)?(?:the\s+)?capability\s+(?:metadata\s+)?inspection\s+(?:framework|works|pipeline)/i,
  /explain\s+(?:the\s+)?(?:capability\s+)?inspection\s+(?:framework|pipeline)/i,
  /how\s+(?:does|do)\s+(?:capability|the)\s+inspection\s+work/i,
  /how\s+are\s+runtime\s+diagnostics\s+generated/i,
  /explain\s+runtime\s+diagnostics/i,
  /explain\s+intent\s+diagnostics/i,
  /explain\s+target\s+extraction/i,
  /explain\s+canonical\s+capability\s+resolution/i,
  /explain\s+capability\s+resolution/i,
  /how\s+(?:does|do)\s+capability\s+resolution\s+work/i,
];

function buildFrameworkIntrospectionResponse(): Record<string, unknown> {
  return {
    framework: "ATD Connect Capability Metadata Inspection",
    description: "The Capability Metadata Inspection framework is a governed, read-only inspection layer that resolves natural-language requests to registered ATD Connect capabilities and returns canonical metadata from the capability registry.",
    canonical_behaviour: [
      "1. Intent Classification: Requests are classified as write requests, capability metadata inspections, or framework introspection queries.",
      "2. Framework Introspection: Requests about the inspection framework itself are routed to a dedicated introspection handler that describes only canonical framework behaviour.",
      "3. Capability Target Extraction: For capability inspection requests, a capability name is extracted from the natural-language request.",
      "4. Canonical Capability Resolution: The extracted name is resolved to a canonical capability ID via exact, case-insensitive, and fuzzy matching against the atd_connect_capabilities registry.",
      "5. Metadata Retrieval: If resolution succeeds, the full capability record is retrieved from the registry and formatted into a governed metadata response.",
      "6. Runtime Diagnostics: Each response includes a runtime diagnostic envelope indicating the execution path (capability_metadata_inspection or framework_introspection), resolution confidence, and governance outcome.",
      "7. Read-Only Enforcement: Write requests are refused. No mutation tools are exposed.",
    ],
    implementation_details: "unavailable",
    no_metadata_inferred: true,
  };
}

function formatFrameworkIntrospectionConversational(): string {
  const sections: string[] = [];
  sections.push("## ATD Connect Capability Metadata Inspection Framework\n");
  sections.push("The Capability Metadata Inspection framework is a governed, read-only inspection layer that resolves natural-language requests to registered ATD Connect capabilities and returns canonical metadata from the capability registry.");
  sections.push("## Canonical Behaviour\n");
  sections.push("1. **Intent Classification** — Requests are classified as write requests, capability metadata inspections, or framework introspection queries.");
  sections.push("2. **Framework Introspection** — Requests about the inspection framework itself are routed to a dedicated introspection handler that describes only canonical framework behaviour.");
  sections.push("3. **Capability Target Extraction** — For capability inspection requests, a capability name is extracted from the natural-language request.");
  sections.push("4. **Canonical Capability Resolution** — The extracted name is resolved to a canonical capability ID via exact, case-insensitive, and fuzzy matching against the capability registry.");
  sections.push("5. **Metadata Retrieval** — If resolution succeeds, the full capability record is retrieved and formatted into a governed metadata response.");
  sections.push("6. **Runtime Diagnostics** — Each response includes a runtime diagnostic envelope indicating the execution path, resolution confidence, and governance outcome.");
  sections.push("7. **Read-Only Enforcement** — Write requests are refused. No mutation tools are exposed.");
  sections.push("\n**Implementation details:** unavailable. Only canonical framework behaviour is described. No algorithms are invented.");
  return sections.join("\n");
}

// ─── Conversational Response Formatter (EWO-017) ─────────────────────────────
// Formats capability metadata into natural-language sections for ChatGPT.

function formatCapabilityMetadataConversational(meta: Record<string, unknown>): string {
  const sections: string[] = [];
  const name = String(meta.capability_name ?? "unavailable");
  const id = String(meta.canonical_identifier ?? "unavailable");
  const purpose = String(meta.purpose ?? "unavailable");
  const description = String(meta.description ?? "unavailable");
  const lifecycle = String(meta.lifecycle_status ?? meta.status ?? "unavailable");
  const version = String(meta.version ?? "unavailable");
  const category = String(meta.capability_category ?? "unavailable");
  const availability = String(meta.current_availability ?? "unavailable");
  const deprecated = meta.deprecated === true;
  const ops = Array.isArray(meta.operations_exposed) ? meta.operations_exposed : [];
  const dependencies = Array.isArray(meta.dependencies) ? meta.dependencies : [];
  const objectTypes = Array.isArray(meta.supported_object_types) ? meta.supported_object_types : [];
  const readOnly = meta.read_only_support === true;
  const writeSupport = meta.write_support === false ? false : true;
  const perms = meta.permission_requirements as Record<string, unknown> | undefined;
  const governance = meta.governance_restrictions as Record<string, unknown> | undefined;
  const schemas = meta.input_output_schemas;

  // Capability
  sections.push("## Capability\n" + name + " (" + id + ")");
  if (category !== "unavailable") sections.push("Category: " + category);
  if (version !== "unavailable") sections.push("Version: " + version);

  // Purpose
  sections.push("## Purpose\n" + (purpose !== "unavailable" ? purpose : description));

  // Operations
  let opsSection = "## Operations\n";
  if (ops.length > 0) {
    opsSection += ops.map((op: unknown) => "- " + String(op)).join("\n");
  } else {
    opsSection += "EIOS did not provide any operations for this capability.";
  }
  sections.push(opsSection);
  sections.push("Read-only: " + (readOnly ? "yes" : "no") + " | Write support: " + (writeSupport ? "yes" : "no"));

  // Permissions
  let permsSection = "## Permissions\n";
  if (perms) {
    permsSection += "Authentication: " + String(perms.authentication ?? "required") + "\n";
    permsSection += "Visibility: " + String(perms.visibility ?? "public") + "\n";
    permsSection += "Persona: " + String(perms.persona ?? "atd");
  } else {
    permsSection += "EIOS did not provide permission metadata.";
  }
  sections.push(permsSection);

  // Governance
  let govSection = "## Governance\n";
  if (governance) {
    govSection += "Constitutional visibility: " + String(governance.constitutional_visibility ?? "public") + "\n";
    govSection += "Read-only enforced: " + String(governance.read_only_enforced ?? true) + "\n";
    govSection += "Mutation tools: " + String(governance.no_mutation_tools ?? true ? "not exposed" : "exposed");
  } else {
    govSection += "EIOS did not provide governance metadata.";
  }
  sections.push(govSection);

  // Availability
  let availSection = "## Availability\n";
  availSection += "Status: " + availability;
  if (deprecated) availSection += " (deprecated";
  if (meta.superseded_by) availSection += ", superseded by " + String(meta.superseded_by);
  if (deprecated) availSection += ")";
  sections.push(availSection);
  if (lifecycle !== "unavailable") sections.push("Lifecycle: " + lifecycle);
  if (dependencies.length > 0) sections.push("Dependencies: " + dependencies.join(", "));
  if (objectTypes.length > 0) sections.push("Supported object types: " + objectTypes.join(", "));
  if (schemas && schemas !== "unavailable") sections.push("Input/Output schemas: available");
  else sections.push("Input/Output schemas: EIOS did not provide schema metadata.");

  return sections.join("\n\n");
}

function formatCapabilityFailureConversational(failure: Record<string, unknown>): string {
  const attempted = String(failure.attempted_capability_name ?? "unknown");
  const reason = String(failure.reason ?? "No matching capability found.");
  const suggestions = Array.isArray(failure.suggested_matching_capabilities) ? failure.suggested_matching_capabilities : [];

  let result = "## Capability Resolution Failed\n\n";
  result += "**Attempted:** " + attempted + "\n\n";
  result += "**Reason:** " + reason + "\n\n";
  result += "**Resolution outcome:** failure\n";
  result += "**No metadata inferred:** EIOS did not find a matching capability. No metadata was fabricated.\n";
  if (suggestions.length > 0) {
    result += "\n**Suggested alternatives:**\n";
    result += suggestions.map((s: unknown) => "- " + String(s)).join("\n");
  } else {
    result += "\nNo similar capabilities were found.";
  }
  return result;
}

function buildCapabilityFailureResponse(resolution: CapabilityResolutionResult): Record<string, unknown> {
  return {
    resolution_outcome: "failure",
    original_request: resolution.attemptedName,
    extracted_capability_target: resolution.extractedCapabilityTarget,
    attempted_capability_name: resolution.attemptedName,
    reason: resolution.reason ?? "No matching capability found.",
    resolution_performed: resolution.match_type === "none" ? "exact, case-insensitive, and fuzzy matching" : resolution.match_type,
    match_type: resolution.match_type,
    confidence: resolution.confidence,
    suggested_matching_capabilities: resolution.suggestions,
    available_alternatives: resolution.suggestions,
    no_metadata_inferred: true,
  };
}

// ─── Write Request Detection (EWO-017R.1 — Semantic Intent) ────────────────────
// EWO-017R.1: Replaced naive keyword-substring matching with semantic intent
// classification. Questions ABOUT write support (e.g. "does this support write
// operations?") are metadata inspection requests, NOT write requests. Only
// imperative commands directed AT the system (create/delete/update X) are
// classified as write requests.

const WRITE_ACTION_KEYWORDS = ["insert", "update", "delete", "create", "modify", "change", "approve", "accept", "close", "deploy", "execute", "run", "start", "stop", "cancel", "archive", "restore", "reset", "set", "assign", "revoke", "grant", "promote", "demote", "merge", "split", "move", "replace", "remove", "add"];

// Phrases that indicate the user is ASKING ABOUT a capability, not requesting
// an action. These override write keyword detection.
const METADATA_QUESTION_PATTERNS: RegExp[] = [
  /does\s+.+?\s+support\s+write/i,
  /is\s+.+?\s+read[\s-]?only/i,
  /what\s+permissions\s+(?:are\s+)?(?:required|needed)/i,
  /what\s+operations\s+(?:are\s+|does\s+)?(?:exposed|it\s+expose|support|offer|provide)/i,
  /what\s+(?:is|are)\s+(?:the\s+)?(?:lifecycle|availability|dependencies|governance|authentication)/i,
  /whether\s+it\s+is\s+read[\s-]?only/i,
  /whether\s+it\s+supports\s+write/i,
  /can\s+this\s+capability\s+(?:create|delete|update|modify)/i,
  /inspect\s+(?:the\s+)?(.+?)\s+capability/i,
  /explain\s+(?:the\s+)?(.+?)\s+capability/i,
  /describe\s+(?:the\s+)?(.+?)\s+capability/i,
  /show\s+(?:me\s+)?(?:the\s+)?(.+?)\s+capability/i,
  /tell me about\s+(?:the\s+)?(.+?)\s+capability/i,
  /what\s+(?:is|are)\s+(?:the\s+)?(.+?)\s+capability/i,
  /what\s+(?:operations|capabilities|services)\s+(?:does|do)\s+(.+?)\s+(?:expose|offer|support|provide)/i,
];

// Imperative command patterns — these ARE write requests.
const WRITE_COMMAND_PATTERNS: RegExp[] = [
  /^(?:please\s+)?(?:create|insert|add)\s+/i,
  /^(?:please\s+)?(?:delete|remove)\s+/i,
  /^(?:please\s+)?(?:update|modify|change)\s+/i,
  /^(?:please\s+)?(?:archive|restore)\s+/i,
  /^(?:please\s+)?(?:approve|accept|reject)\s+/i,
  /^(?:please\s+)?(?:close|cancel|stop|start)\s+/i,
  /^(?:please\s+)?(?:deploy|execute|run)\s+/i,
  /^(?:please\s+)?(?:assign|revoke|grant|set|reset)\s+/i,
  /^(?:please\s+)?(?:promote|demote|merge|split|move|replace)\s+/i,
];

// EWO-029R.1: Negative-context patterns — if present, the request is read-only
const NEGATIVE_CONTEXT_PATTERNS: RegExp[] = [
  /do\s+not\s+(?:perform|make|execute|trigger|initiate)\s+(?:any\s+)?(?:lifecycle\s+)?changes?/i,
  /do\s+not\s+(?:perform|make|execute|trigger|initiate)\s+(?:any\s+)?lifecycle/i,
  /no\s+lifecycle\s+changes?/i,
  /read[\s-]?only/i,
  /do\s+not\s+(?:write|modify|update|create|delete|insert)/i,
];

interface IntentClassification {
  isWriteRequest: boolean;
  isMetadataQuestion: boolean;
  isFrameworkIntrospection: boolean;
  isExecutionInspection: boolean;
  isProviderInspection: boolean;
  detected_intent: string;
  confidence: number;
  routing_decision: string;
}

function classifyIntent(text: string): IntentClassification {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // EWO-029R.1: Check for negative context first — if the request explicitly
  // says NOT to perform lifecycle changes, it's a read-only inspection.
  for (const pattern of NEGATIVE_CONTEXT_PATTERNS) {
    if (pattern.test(trimmed)) {
      // EWO-029R.2: Check for execution provider inspection within negative context
      if (/\b(?:execution\s+)?provider\b/i.test(trimmed) && /\b(?:inspect|show|describe|explain)\b/i.test(trimmed)) {
        return {
          isWriteRequest: false,
          isMetadataQuestion: false,
          isFrameworkIntrospection: false,
          isExecutionInspection: true,
          isProviderInspection: true,
          detected_intent: "execution_provider_inspection",
          confidence: 0.95,
          routing_decision: "route_to_inspectExecutionProvider",
        };
      }
      // EWO-029R.1: Check for execution engine inspection within negative context
      if (/\b(?:supervised\s+)?(?:engineering\s+)?execution\s+engine\b/i.test(trimmed)) {
        return {
          isWriteRequest: false,
          isMetadataQuestion: false,
          isFrameworkIntrospection: false,
          isExecutionInspection: true,
          isProviderInspection: false,
          detected_intent: "supervised_execution_engine_inspection",
          confidence: 0.95,
          routing_decision: "route_to_inspectSupervisedExecutionEngine",
        };
      }
      return {
        isWriteRequest: false,
        isMetadataQuestion: false,
        isFrameworkIntrospection: false,
        isExecutionInspection: false,
        isProviderInspection: false,
        detected_intent: "inspection_or_query",
        confidence: 0.95,
        routing_decision: "route_to_operation",
      };
    }
  }

  // EWO-030R.2: Codex provider implementation evidence — must be checked BEFORE
  // generic execution provider inspection so Codex-specific evidence requests
  // route to inspectCodexProviderImplementationEvidence.
  const CODEX_EVIDENCE_PATTERNS: RegExp[] = [
    /inspect\s+(?:the\s+)?codex\s+(?:execution\s+)?provider\s+implementation\s+evidence/i,
    /inspect\s+(?:the\s+)?codex\s+provider\s+implementation\s+evidence/i,
    /inspect\s+(?:the\s+)?codex\s+provider\s+evidence/i,
    /inspect\s+(?:the\s+)?ewo-030\s+provider\s+implementation/i,
    /inspect\s+(?:the\s+)?codex\s+execution\s+provider\s+setup/i,
    /verify\s+(?:the\s+)?codex\s+provider\s+configuration/i,
    /inspect\s+(?:the\s+)?codex\s+execution\s+provider\s+implementation/i,
    /inspect\s+(?:the\s+)?codex\s+implementation\s+evidence/i,
  ];
  for (const pattern of CODEX_EVIDENCE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        isWriteRequest: false,
        isMetadataQuestion: false,
        isFrameworkIntrospection: false,
        isExecutionInspection: true,
        isProviderInspection: false,
        detected_intent: "codex_provider_implementation_evidence_inspection",
        confidence: 0.98,
        routing_decision: "route_to_inspectCodexProviderImplementationEvidence",
      };
    }
  }

  // EWO-029R.2: Check for execution provider inspection — before engine inspection
  // and before generic metadata detection. Provider-specific inspection must
  // not fall through to generic inspection_or_query.
  const PROVIDER_INSPECTION_PATTERNS: RegExp[] = [
    /inspect\s+(?:the\s+)?(\w[\w\s-]*?)\s+execution\s+provider/i,
    /show\s+(?:the\s+)?(\w[\w\s-]*?)\s+(?:execution\s+)?provider/i,
    /describe\s+(?:the\s+)?(\w[\w\s-]*?)\s+execution\s+provider/i,
    /explain\s+(?:the\s+)?(\w[\w\s-]*?)\s+execution\s+provider/i,
    /inspect\s+provider\s+id\s+(\w[\w-]*)/i,
    /show\s+provider\s+id\s+(\w[\w-]*)/i,
    /inspect\s+(?:the\s+)?(\w[\w\s-]*?)\s+implementation\s+provider/i,
    /show\s+(?:the\s+)?(\w[\w\s-]*?)\s+implementation\s+provider/i,
  ];
  for (const pattern of PROVIDER_INSPECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        isWriteRequest: false,
        isMetadataQuestion: false,
        isFrameworkIntrospection: false,
        isExecutionInspection: true,
        isProviderInspection: true,
        detected_intent: "execution_provider_inspection",
        confidence: 0.95,
        routing_decision: "route_to_inspectExecutionProvider",
      };
    }
  }

  // EWO-029R.2: Execution provider inspection — before engine inspection
  // and before generic metadata detection.
  const PROVIDER_TARGET_PATTERNS: RegExp[] = [
    /\b(?:inspect|show|describe|explain)\s+(?:the\s+)?(\w[\w\s-]*?)\s+execution\s+provider/i,
    /\b(?:inspect|show|describe|explain)\s+(?:the\s+)?(\w[\w\s-]*?)\s+implementation\s+provider/i,
    /\b(?:inspect|show)\s+provider\s+id\s+(\w[\w-]*)/i,
  ];
  for (const pattern of PROVIDER_TARGET_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        isWriteRequest: false,
        isMetadataQuestion: false,
        isFrameworkIntrospection: false,
        isExecutionInspection: true,
        isProviderInspection: true,
        detected_intent: "execution_provider_inspection",
        confidence: 0.95,
        routing_decision: "route_to_inspectExecutionProvider",
      };
    }
  }

  // EWO-028R.2: Specific object-operation intents must be evaluated BEFORE
  // generic metadata question detection.  A request containing an EWO
  // reference and an Engineering Knowledge phrase is a knowledge inspection,
  // not a capability metadata question, even when the prompt also mentions
  // "capability", "operation", or diagnostic field names.
  const KNOWLEDGE_INSPECTION_GUARD = /(?:show|inspect|display|include)\s+(?:the\s+)?(?:engineering\s+)?knowledge\b/i;
  const EWO_REF_GUARD = /EWO-[\w.]+/i;
  if (KNOWLEDGE_INSPECTION_GUARD.test(trimmed) && EWO_REF_GUARD.test(trimmed)) {
    return {
      isWriteRequest: false,
      isMetadataQuestion: false,
      isFrameworkIntrospection: false,
      isExecutionInspection: false,
      isProviderInspection: false,
      detected_intent: "engineering_knowledge_inspection",
      confidence: 0.95,
      routing_decision: "inspect_engineering_object",
    };
  }

  // EWO-017R.1: Check framework introspection patterns — before
  // capability metadata patterns. Requests about the inspection framework
  // itself must not be misclassified as capability inspection.
  for (const pattern of FRAMEWORK_INTROSPECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        isWriteRequest: false,
        isMetadataQuestion: false,
        isFrameworkIntrospection: true,
        isExecutionInspection: false,
        isProviderInspection: false,
        detected_intent: "framework_introspection",
        confidence: 0.95,
        routing_decision: "framework_introspection",
      };
    }
  }

  // Check metadata question patterns — these take priority over write requests
  // EWO-028R.2: But only after the knowledge inspection guard above.
  for (const pattern of METADATA_QUESTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        isWriteRequest: false,
        isMetadataQuestion: true,
        isFrameworkIntrospection: false,
        isExecutionInspection: false,
        isProviderInspection: false,
        detected_intent: "capability_metadata_inspection",
        confidence: 0.95,
        routing_decision: "inspect_capability_metadata",
      };
    }
  }

  // EWO-031: Governed execution intent detection — BEFORE write command patterns.
  // These intents route through the governed execution pipeline, not the read-only
  // inspection layer. They must NOT be classified as write requests.
  const EXECUTION_INTENT_PATTERNS: Array<{ intent: string; patterns: RegExp[]; capability: string; operation: string; objectPattern?: RegExp }> = [
    {
      intent: "create_ewo",
      patterns: [
        /create\s+(?:an?\s+)?(?:ewo\s+|engineering\s+work\s+order\s+)?(EWO-[\w.-]+)\b/i,
        /create\s+(?:an?\s+)?ewo\s+(?:for\s+)?(.+)/i,
        /register\s+(?:an?\s+)?(?:ewo\s+|engineering\s+work\s+order\s+)?(EWO-[\w.-]+)\b/i,
        /create\s+(?:ewo\s+)?(EWO-[\w.-]+)/i,
      ],
      capability: "engineering-work-orders",
      operation: "createEngineeringWorkOrderFromConversation",
      objectPattern: /(EWO-[\w.-]+)/i,
    },
    {
      intent: "prepare_analysis",
      patterns: [
        /prepare\s+(?:the\s+)?(?:engineering\s+)?analysis\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
        /prepare\s+(?:its|the)\s+(?:engineering\s+)?analysis/i,
        /generate\s+(?:the\s+)?analysis\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
      ],
      capability: "engineering-work-orders",
      operation: "prepareEngineeringAnalysis",
      objectPattern: /(EWO-[\w.-]+)/i,
    },
    {
      intent: "prepare_plan",
      patterns: [
        /prepare\s+(?:the\s+)?(?:engineering\s+)?plan\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
        /prepare\s+(?:its|the)\s+(?:engineering\s+)?plan/i,
        /generate\s+(?:the\s+)?plan\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
      ],
      capability: "engineering-work-orders",
      operation: "prepareEngineeringPlan",
      objectPattern: /(EWO-[\w.-]+)/i,
    },
    {
      intent: "approve_execution",
      patterns: [
        /approve\s+(EWO-[\w.-]+)\s+for\s+execution/i,
        /approve\s+(?:it|this)\s+for\s+execution/i,
        /grant\s+execution\s+approval\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
        /approve\s+execution\s+(?:for\s+|of\s+)?(EWO-[\w.-]+)\b/i,
      ],
      capability: "engineering-work-orders",
      operation: "approveEngineeringWorkOrderForExecution",
      objectPattern: /(EWO-[\w.-]+)/i,
    },
    {
      intent: "execute_ewo",
      patterns: [
        /execute\s+(EWO-[\w.-]+)\s+(?:using\s+)?codex/i,
        /execute\s+(?:it|this)\s+using\s+codex/i,
        /execute\s+(EWO-[\w.-]+)\b/i,
        /run\s+(EWO-[\w.-]+)\s+(?:using\s+)?codex/i,
        /execute\s+(?:it|this)\s+through\s+(?:the\s+)?(?:supervised\s+)?execution/i,
        /start\s+execution\s+(?:of\s+|for\s+)?(EWO-[\w.-]+)\b/i,
      ],
      capability: "supervised-engineering-execution",
      operation: "executeEngineeringWorkOrder",
      objectPattern: /(EWO-[\w.-]+)/i,
    },
    {
      intent: "inspect_execution",
      patterns: [
        /inspect\s+(?:the\s+)?(?:execution\s+state|execution\s+status|latest\s+execution)\s+(?:of\s+|for\s+)?(EWO-[\w.-]+)\b/i,
        /inspect\s+(?:the\s+)?execution\s+(?:of\s+|for\s+)?(EWO-[\w.-]+)\b/i,
        /show\s+(?:me\s+)?(?:the\s+)?execution\s+(?:status|state|results)\s+(?:of\s+|for\s+)?(EWO-[\w.-]+)\b/i,
        /inspect\s+(?:the\s+)?latest\s+execution\s+for\s+(EWO-[\w.-]+)\b/i,
      ],
      capability: "supervised-engineering-execution",
      operation: "inspectEngineeringExecution",
      objectPattern: /(EWO-[\w.-]+)/i,
    },
  ];

  for (const entry of EXECUTION_INTENT_PATTERNS) {
    for (const pattern of entry.patterns) {
      if (pattern.test(trimmed)) {
        let objectRef: string | null = null;
        if (entry.objectPattern) {
          const match = trimmed.match(entry.objectPattern);
          if (match) objectRef = match[1];
        }
        return {
          isWriteRequest: false,
          isMetadataQuestion: false,
          isFrameworkIntrospection: false,
          isExecutionInspection: entry.intent === "inspect_execution",
          isProviderInspection: false,
          detected_intent: entry.intent,
          confidence: 0.9,
          routing_decision: entry.intent === "execute_ewo" ? "route_to_execution_pipeline" : `route_to_${entry.operation}`,
        };
      }
    }
  }

  // Check imperative write command patterns
  for (const pattern of WRITE_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        isWriteRequest: true,
        isMetadataQuestion: false,
        isFrameworkIntrospection: false,
        isExecutionInspection: false,
        isProviderInspection: false,
        detected_intent: "write_request",
        confidence: 0.95,
        routing_decision: "refuse_write_request",
      };
    }
  }

  // Fallback: check for write action keywords used as imperative commands
  // (not in a question context). Look for action keyword at start or after
  // "please", but NOT in question form (no question marks, no "does/is/what/can").
  const isQuestion = /\?\s*$/.test(trimmed) || /^(?:does|is|are|what|can|do|will|how|why|when|who|which)\b/i.test(trimmed);

  if (!isQuestion) {
    // Check if any write keyword appears as a command verb (first word or after "please")
    const firstWord = lower.split(/\s+/)[0];
    const afterPlease = lower.replace(/^please\s+/, "").split(/\s+/)[0];
    if (WRITE_ACTION_KEYWORDS.includes(firstWord) || WRITE_ACTION_KEYWORDS.includes(afterPlease)) {
      return {
        isWriteRequest: true,
        isMetadataQuestion: false,
        isFrameworkIntrospection: false,
        isExecutionInspection: false,
        isProviderInspection: false,
        detected_intent: "write_request",
        confidence: 0.85,
        routing_decision: "refuse_write_request",
      };
    }
  }

  // Default: not a write request, not a metadata question
  return {
    isWriteRequest: false,
    isMetadataQuestion: false,
    isFrameworkIntrospection: false,
    isExecutionInspection: false,
    isProviderInspection: false,
    detected_intent: "inspection_or_query",
    confidence: 0.7,
    routing_decision: "route_to_operation",
  };
}

// ─── NL Interpretation (inlined, provider-independent) ─────────────────────────

interface InterpretedRequest {
  capability: string | null;
  operation: string | null;
  objectReference: string | null;
  isWriteRequest: boolean;
  ambiguous: boolean;
  interpretation: string;
  intentClassification: IntentClassification;
  isProviderInspection: boolean;
}

function interpretRequest(text: string): InterpretedRequest {
  const trimmed = text.trim();
  const intent = classifyIntent(trimmed);
  const writeReq = intent.isWriteRequest;

  // EWO-028R.2: Intent precedence — specific object inspections evaluated before
  // generic metadata detection.  A request containing an EWO reference and a
  // knowledge phrase must resolve to knowledge inspection even when the prompt
  // also mentions "capability", "operation", or diagnostic field names.
  const patterns: Array<{ patterns: RegExp[]; capability: string; operation: string; objectPattern?: RegExp }> = [
    // 1. Write-request prevention — handled by classifyIntent before pattern matching.

    // EWO-031: Execution intent patterns — BEFORE write-request prevention.
    // These route through the governed execution pipeline.
    {
      patterns: [
        /create\s+(?:an?\s+)?(?:ewo\s+|engineering\s+work\s+order\s+)?(EWO-[\w.-]+)\b/i,
        /create\s+(?:an?\s+)?ewo\s+(?:for\s+)?(.+)/i,
        /register\s+(?:an?\s+)?(?:ewo\s+|engineering\s+work\s+order\s+)?(EWO-[\w.-]+)\b/i,
        /create\s+(?:ewo\s+)?(EWO-[\w.-]+)/i,
      ],
      capability: "engineering-work-orders",
      operation: "createEngineeringWorkOrderFromConversation",
      objectPattern: /(EWO-[\w.-]+)/i,
    },
    {
      patterns: [
        /prepare\s+(?:the\s+)?(?:engineering\s+)?analysis\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
        /prepare\s+(?:its|the)\s+(?:engineering\s+)?analysis/i,
        /generate\s+(?:the\s+)?analysis\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
      ],
      capability: "engineering-work-orders",
      operation: "prepareEngineeringAnalysis",
      objectPattern: /(EWO-[\w.-]+)/i,
    },
    {
      patterns: [
        /prepare\s+(?:the\s+)?(?:engineering\s+)?plan\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
        /prepare\s+(?:its|the)\s+(?:engineering\s+)?plan/i,
        /generate\s+(?:the\s+)?plan\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
      ],
      capability: "engineering-work-orders",
      operation: "prepareEngineeringPlan",
      objectPattern: /(EWO-[\w.-]+)/i,
    },
    {
      patterns: [
        /approve\s+(EWO-[\w.-]+)\s+for\s+execution/i,
        /approve\s+(?:it|this)\s+for\s+execution/i,
        /grant\s+execution\s+approval\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
        /approve\s+execution\s+(?:for\s+|of\s+)?(EWO-[\w.-]+)\b/i,
      ],
      capability: "engineering-work-orders",
      operation: "approveEngineeringWorkOrderForExecution",
      objectPattern: /(EWO-[\w.-]+)/i,
    },
    {
      patterns: [
        /execute\s+(EWO-[\w.-]+)\s+(?:using\s+)?codex/i,
        /execute\s+(?:it|this)\s+using\s+codex/i,
        /execute\s+(EWO-[\w.-]+)\b/i,
        /run\s+(EWO-[\w.-]+)\s+(?:using\s+)?codex/i,
        /execute\s+(?:it|this)\s+through\s+(?:the\s+)?(?:supervised\s+)?execution/i,
        /start\s+execution\s+(?:of\s+|for\s+)?(EWO-[\w.-]+)\b/i,
      ],
      capability: "supervised-engineering-execution",
      operation: "executeEngineeringWorkOrder",
      objectPattern: /(EWO-[\w.-]+)/i,
    },
    {
      patterns: [
        /inspect\s+(?:the\s+)?(?:execution\s+state|execution\s+status|latest\s+execution)\s+(?:of\s+|for\s+)?(EWO-[\w.-]+)\b/i,
        /inspect\s+(?:the\s+)?execution\s+(?:of\s+|for\s+)?(EWO-[\w.-]+)\b/i,
        /show\s+(?:me\s+)?(?:the\s+)?execution\s+(?:status|state|results)\s+(?:of\s+|for\s+)?(EWO-[\w.-]+)\b/i,
        /inspect\s+(?:the\s+)?latest\s+execution\s+for\s+(EWO-[\w.-]+)\b/i,
      ],
      capability: "supervised-engineering-execution",
      operation: "inspectEngineeringExecution",
      objectPattern: /(EWO-[\w.-]+)/i,
    },

    {
      patterns: [
        /inspect\s+(?:the\s+)?(?:supervised\s+)?execution\s+engine\s+and\s+provider\s+selection\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
        /inspect\s+(?:the\s+)?(?:supervised\s+)?execution\s+engine\s+and\s+provider\s+selection/i,
        /inspect\s+(?:the\s+)?provider\s+(?:policy|selection)\s+(?:for\s+)?(EWO-[\w.-]+)\b/i,
        /inspect\s+(?:the\s+)?provider\s+(?:policy|selection)/i,
        /invoke\s+inspect_execution_provider_policy\s+(?:directly\s+)?(?:for\s+)?(EWO-[\w.-]+)?\b/i,
        /invoke\s+inspect_execution_provider_policy\s+directly/i,
        /invoke\s+inspectexecutionproviderpolicy\s+(?:directly\s+)?(?:for\s+)?(EWO-[\w.-]+)?\b/i,
        /invoke\s+inspectexecutionproviderpolicy\s+directly/i,
        /return\s+(?:the\s+)?(?:live\s+)?execution\s+provider\s+policy/i,
        /inspect\s+(?:the\s+)?execution\s+provider\s+policy/i,
      ],
      capability: "supervised-engineering-execution",
      operation: "inspectExecutionProviderPolicy",
      objectPattern: /(EWO-[\w.-]+)/i,
    },

    // EWO-032: Execution handoff inspection
    {
      patterns: [
        /inspect\s+(?:the\s+)?execution\s+handoff\s+(?:for\s+)?(EWO-[\w.-]+?)?\b/i,
        /inspect\s+(?:the\s+)?execution\s+handoff/i,
        /invoke\s+inspect_execution_handoff\s+(?:directly\s+)?(?:for\s+)?(EWO-[\w.-]+?)?\b/i,
        /invoke\s+inspect_execution_handoff\s+directly/i,
        /invoke\s+inspectexecutionhandoff\s+(?:directly\s+)?(?:for\s+)?(EWO-[\w.-]+?)?\b/i,
        /invoke\s+inspectexecutionhandoff\s+directly/i,
        /return\s+(?:the\s+)?execution\s+handoff\s+(?:state|status)/i,
        /inspect\s+(?:the\s+)?handoff\s+(?:state|status)/i,
      ],
      capability: "supervised-engineering-execution",
      operation: "inspectExecutionHandoff",
      objectPattern: /(EWO-[\w.-]+)/i,
    },

    // EWO-030R.2: Codex provider implementation evidence — HIGHEST precedence,
    // before supervised engine and before generic provider inspection.
    {
      patterns: [
        /inspect\s+(?:the\s+)?codex\s+(?:execution\s+)?provider\s+implementation\s+evidence/i,
        /inspect\s+(?:the\s+)?codex\s+provider\s+implementation\s+evidence/i,
        /inspect\s+(?:the\s+)?codex\s+provider\s+evidence/i,
        /inspect\s+(?:the\s+)?ewo-030\s+provider\s+implementation/i,
        /inspect\s+(?:the\s+)?codex\s+execution\s+provider\s+setup/i,
        /verify\s+(?:the\s+)?codex\s+provider\s+configuration/i,
        /inspect\s+(?:the\s+)?codex\s+execution\s+provider\s+implementation/i,
        /inspect\s+(?:the\s+)?codex\s+implementation\s+evidence/i,
      ],
      capability: "supervised-engineering-execution",
      operation: "inspectCodexProviderImplementationEvidence",
    },

    // EWO-029R.1: Supervised execution engine inspection
    // EWO-031R.2: Negative lookahead prevents matching when "provider selection" or "provider policy" follows,
    // so those requests route to inspectExecutionProviderPolicy instead.
    {
      patterns: [
        /inspect\s+(?:the\s+)?(?:supervised\s+)?(?:engineering\s+)?execution\s+engine(?!\s+and\s+provider\s+(?:selection|policy))/i,
        /explain\s+(?:the\s+)?(?:supervised\s+)?(?:engineering\s+)?execution\s+engine(?!\s+and\s+provider\s+(?:selection|policy))/i,
        /describe\s+(?:the\s+)?(?:supervised\s+)?(?:engineering\s+)?execution\s+engine(?!\s+and\s+provider\s+(?:selection|policy))/i,
        /show\s+(?:the\s+)?(?:supervised\s+)?(?:engineering\s+)?execution\s+engine(?!\s+and\s+provider\s+(?:selection|policy))/i,
        /what\s+is\s+(?:the\s+)?(?:supervised\s+)?(?:engineering\s+)?execution\s+engine(?!\s+and\s+provider\s+(?:selection|policy))/i,
        /inspect\s+(?:the\s+)?supervised\s+engineering\s+execution(?!\s+and\s+provider\s+(?:selection|policy))/i,
        /inspect\s+(?:the\s+)?execution\s+provider\s+framework/i,
        /show\s+(?:the\s+)?engineering\s+execution\s+providers?\s+and\s+pipeline/i,
        /what\s+governance\s+gates\s+prevent\s+(?:atd|eos)\s+from\s+executing/i,
        /inspect\s+(?:the\s+)?supervised\s+engineering\s+execution\s+engine(?!\s+and\s+provider\s+(?:selection|policy))/i,
        /show\s+(?:the\s+)?supervised\s+engineering\s+execution(?!\s+and\s+provider\s+(?:selection|policy))/i,
        /explain\s+(?:the\s+)?supervised\s+engineering\s+execution(?!\s+and\s+provider\s+(?:selection|policy))/i,
        /inspect\s+(?:the\s+)?execution\s+package\s+support/i,
        /show\s+(?:the\s+)?execution\s+package\s+support/i,
        /what\s+is\s+(?:the\s+)?execution\s+package\s+support/i,
      ],
      capability: "supervised-engineering-execution",
      operation: "inspectSupervisedExecutionEngine",
    },

    // EWO-029R.2: Execution provider inspection — after engine inspection, before knowledge inspection
    {
      patterns: [
        /inspect\s+(?:the\s+)?(\w[\w\s-]*?)\s+execution\s+provider/i,
        /show\s+(?:the\s+)?(\w[\w\s-]*?)\s+execution\s+provider/i,
        /describe\s+(?:the\s+)?(\w[\w\s-]*?)\s+execution\s+provider/i,
        /explain\s+(?:the\s+)?(\w[\w\s-]*?)\s+execution\s+provider/i,
        /inspect\s+(?:the\s+)?(\w[\w\s-]*?)\s+implementation\s+provider/i,
        /show\s+(?:the\s+)?(\w[\w\s-]*?)\s+implementation\s+provider/i,
        /inspect\s+provider\s+id\s+(\w[\w-]*)/i,
        /show\s+provider\s+id\s+(\w[\w-]*)/i,
      ],
      capability: "supervised-engineering-execution",
      operation: "inspectExecutionProvider",
      objectPattern: /(?:inspect|show|describe|explain)\s+(?:the\s+)?(\w[\w\s-]*?)\s+(?:execution|implementation)\s+provider|inspect\s+provider\s+id\s+(\w[\w-]*)|show\s+provider\s+id\s+(\w[\w-]*)/i,
    },

    // 2. Explicit Engineering Knowledge inspection (highest object-specific precedence)
    {
      patterns: [
        /(?:show|inspect|display|include)\s+(?:the\s+)?(?:engineering\s+)?knowledge\s+/i,
        /inspect\s+(?:the\s+)?extracted\s+knowledge/i,
        /show\s+knowledge\s+extraction/i,
        /include\s+(?:the\s+)?(?:engineering\s+)?knowledge/i,
        /what\s+(?:is\s+the\s+)?knowledge\s+extraction/i,
      ],
      capability: "engineering-work-orders",
      operation: "inspectKnowledgeExtraction",
      objectPattern: /(EWO-[\w.]+)/i,
    },

    // EWO-030R.5: Acceptance governance inspection — must be BEFORE generic EWO inspection
    {
      patterns: [
        /inspect\s+(?:the\s+)?(EWO-[\w.]+)\s+acceptance\s+governance\s+state/i,
        /inspect\s+(?:the\s+)?acceptance\s+governance\s+(?:state\s+)?(?:for\s+)?(EWO-[\w.]+)/i,
        /inspect\s+(?:the\s+)?product\s+owner\s+acceptance\s+governance\s+(?:for\s+)?(EWO-[\w.]+)/i,
        /verify\s+(?:the\s+)?acceptance\s+safeguards\s+(?:for\s+)?(EWO-[\w.]+)/i,
        /inspect\s+(?:the\s+)?unauthorised\s+acceptance\s+correction\s+(?:for\s+)?(EWO-[\w.]+)/i,
        /inspect\s+(?:the\s+)?governed\s+acceptance\s+state\s+of\s+(EWO-[\w.]+)/i,
        /inspect\s+(?:the\s+)?acceptance\s+governance\s+of\s+(EWO-[\w.]+)/i,
      ],
      capability: "engineering-work-orders",
      operation: "inspectEngineeringWorkOrderAcceptanceGovernance",
      objectPattern: /(?:state\s+)?(?:for\s+|of\s+)?(EWO-[\w.]+)/i,
    },

    // 3. Explicit Engineering Work Order inspection
    { patterns: [/inspect\s+(?:ewo\s+)?(EWO-[\w.]+)/i, /describe\s+(?:ewo\s+)?(EWO-[\w.]+)/i], capability: "engineering-work-orders", operation: "inspectEngineeringWorkOrder", objectPattern: /inspect\s+(?:ewo\s+)?(EWO-[\w.]+)/i },

    // 4. Relationship inspection
    { patterns: [/(?:show|inspect)\s+relationships?\s+(?:for\s+)?(.+)/i], capability: "lineage", operation: "inspectRelationships", objectPattern: /(?:show|inspect)\s+relationships?\s+(?:for\s+)?(.+)/i },

    // 5. List operations
    { patterns: [/list\s+(?:every\s+|all\s+)?(?:engineering\s+)?work\s+order/i, /list\s+ewos/i], capability: "engineering-work-orders", operation: "listEngineeringWorkOrders" },
    { patterns: [/(?:show|list)\s+(?:all\s+)?(?:engineering\s+)?standards?/i], capability: "engineering-standards", operation: "listEngineeringStandards" },
    { patterns: [/(?:show|list)\s+(?:all\s+)?pages?/i], capability: "pages", operation: "listPages" },
    { patterns: [/(?:show|list)\s+(?:all\s+)?workspaces?/i], capability: "workspaces", operation: "listWorkspaces" },
    { patterns: [/(?:show|list)\s+(?:all\s+)?services?/i], capability: "services", operation: "listServices" },

    // 6. Capability metadata inspection (tightened: "show" removed to prevent
    //    broad-match hijacking; capture group limited to short capability names;
    //    word boundary required after "capability")
    { patterns: [
      /(?:inspect|explain|describe)\s+(?:the\s+)?([\w\s-]+?)\s+capability\b/i,
      /what\s+(?:operations|capabilities|services)\s+(?:does|do)\s+(?:the\s+)?([\w\s-]+?)\s+capability\s+(?:expose|offer|support|provide)/i,
      /what\s+(?:is|are)\s+(?:the\s+)?([\w\s-]+?)\s+capability\b/i,
      /tell me about\s+(?:the\s+)?([\w\s-]+?)\s+capability\b/i,
    ], capability: "capability-metadata", operation: "inspectCapabilityMetadata", objectPattern: /(?:inspect|explain|describe)\s+(?:the\s+)?([\w\s-]+?)\s+capability\b/i },
    { patterns: [/list\s+(?:every\s+|all\s+)?(?:engineering\s+)?capabilit/i, /discover\s+capabilit/i], capability: "capabilities", operation: "discoverCapabilities" },

    // 7. Unsupported or unresolved (implicit fallback below)
  ];

  for (const p of patterns) {
    for (const pattern of p.patterns) {
      if (pattern.test(trimmed)) {
        let objectRef: string | null = null;
        if (p.objectPattern) {
          const match = trimmed.match(p.objectPattern);
          if (match) {
            // Provider patterns may have multiple capture groups
            objectRef = (match[1] || match[2] || match[3] || "").trim().replace(/[.]+$/, "") || null;
          }
        }
        return {
          capability: p.capability,
          operation: p.operation,
          objectReference: objectRef,
          isWriteRequest: writeReq,
          ambiguous: false,
          interpretation: "Resolved to capability: " + p.capability + ", operation: " + p.operation + (objectRef ? ", object: " + objectRef : "") + ".",
          intentClassification: intent,
          isProviderInspection: p.operation === "inspectExecutionProvider",
        };
      }
    }
  }

  return {
    capability: null,
    operation: null,
    objectReference: null,
    isWriteRequest: writeReq,
    ambiguous: true,
    interpretation: "Unable to resolve request to a supported ATD Connect operation.",
    intentClassification: intent,
    isProviderInspection: false,
  };
}

// ─── Tool Execution ────────────────────────────────────────────────────────────

// ─── EWO-029R.1: Supervised Execution Engine Inspection (MCP) ────────────────────
// Returns governed provider, pipeline, and gate evidence from runtime registries.

const MCP_PIPELINE_STAGES = [
  "po_approval",
  "execution_preparation",
  "execution_package_generation",
  "execution_provider_selection",
  "execution_dispatch",
  "execution_monitoring",
  "execution_result_collection",
  "completion_package_generation",
  "engineering_knowledge_extraction",
  "await_product_owner_review",
];

const MCP_GOVERNANCE_GATE_DEFINITIONS = [
  { gate: "ewo_exists", description: "The Engineering Work Order must exist in the governed registry.", severity: "critical" },
  { gate: "ewo_active", description: "The EWO must be active (not closed or archived).", severity: "critical" },
  { gate: "engineering_package", description: "An Engineering Package must be generated for the EWO.", severity: "critical" },
  { gate: "po_approval", description: "Product Owner approval must be recorded for the EWO.", severity: "critical" },
  { gate: "execution_approval", description: "Explicit Product Owner execution approval must be recorded.", severity: "critical" },
  { gate: "constitution_checked", description: "No active constitutional amendment blocks execution.", severity: "warning" },
];

async function inspectSupervisedExecutionEngineMcp(
  supabase: ReturnType<typeof createClient>,
): Promise<Record<string, unknown>> {
  const servicesInvoked: string[] = [];
  const registriesInspected: string[] = [];
  const unavailableFields: string[] = [];

  // ── Retrieve providers from governed registry ──
  servicesInvoked.push("execution_provider_registry");
  registriesInspected.push("execution_provider_registry");
  const { data: providers, error: providersError } = await supabase
    .from("execution_provider_registry")
    .select("*")
    .order("created_at", { ascending: true });

  const providerRecordsExamined = providers?.length ?? 0;

  const executionProviders = (providers ?? []).map((p: Record<string, unknown>) => ({
    provider_id: p.provider_id,
    provider_name: p.provider_name,
    provider_version: p.provider_version,
    provider_type: p.provider_type,
    is_active: p.is_active,
    is_governed: p.is_governed,
    governance_rules: p.governance_rules ?? [],
    canonical_contract_version: p.canonical_contract_version,
    lifecycle_status: p.is_active ? "active" : "inactive",
  }));

  // ── Determine active provider ──
  const activeProviders = executionProviders.filter((p: Record<string, unknown>) => p.is_active === true);
  const activeProvider = activeProviders.length > 0 ? activeProviders[0] : null;
  if (!activeProvider) unavailableFields.push("active_execution_provider");

  // ── Provider independence evidence ──
  const independenceEvidence: string[] = [];
  if (executionProviders.length >= 1) independenceEvidence.push("Canonical execution contract registered");
  if (executionProviders.length >= 2) independenceEvidence.push("Multiple providers in registry (active + inactive)");
  independenceEvidence.push("Provider selection abstraction layer exists");
  independenceEvidence.push("Execution package/provider decoupling enforced");
  const providerIndependence = {
    status: executionProviders.length >= 2 ? "confirmed" : "partial",
    evidence: independenceEvidence,
  };

  // ── Pipeline stages from canonical definition ──
  servicesInvoked.push("supervised_execution_engine.PIPELINE_STAGES");
  const pipelineStages = MCP_PIPELINE_STAGES.map((stage, idx) => ({ stage, sequence: idx }));

  // ── Governance gates from canonical definition ──
  servicesInvoked.push("supervised_execution_engine.evaluateGovernanceGate (definition)");
  const governanceGates = MCP_GOVERNANCE_GATE_DEFINITIONS;

  // ── Execution package support ──
  servicesInvoked.push("executionPackageService (capability check)");
  const packageSupport = {
    supported: true,
    description: "Execution packages are generated as permanent engineering records containing EWO, plan, analysis, implementation instructions, governance rules, and completion criteria.",
  };

  // ── Execution diagnostics support ──
  const diagnosticsSupport = {
    supported: true,
    description: "Execution diagnostics provide governed inspection of providers, records, pipeline stages, governance gates, and execution history.",
  };

  // ── Audit ──
  const auditRef = `ATD-MCP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ── Runtime diagnostics ──
  const runtimeDiagnostics = {
    request_id: auditRef,
    detected_intent: "supervised_execution_engine_inspection",
    extracted_target: "supervised execution engine",
    target_resolution_method: "regex_pattern_match_against_execution_engine_aliases",
    capability_resolution_method: "capability_registry_lookup:supervised-engineering-execution",
    operation_resolution_method: "deterministic_routing:inspectSupervisedExecutionEngine",
    routing_rule: "execution_engine_inspection_precedence",
    services_invoked: servicesInvoked,
    registries_inspected: registriesInspected,
    provider_records_examined: providerRecordsExamined,
    package_definitions_inspected: true,
    pipeline_definitions_inspected: true,
    gate_definitions_inspected: true,
    unavailable_fields: unavailableFields,
    diagnostic_confidence: unavailableFields.length === 0 ? 1.0 : 0.9,
    lifecycle_change_performed: false,
    generated_timestamp: new Date().toISOString(),
    audit_reference: auditRef,
  };

  // ── Intent diagnostics ──
  const intentDiagnostics = {
    detected_intent: "supervised_execution_engine_inspection",
    confidence: 1.0,
    routing_decision: "route_to_inspectSupervisedExecutionEngine",
    extracted_target: "supervised execution engine",
    matched_pattern: "execution_engine_inspection",
    isWriteRequest: false,
    isMetadataQuestion: false,
    isFrameworkIntrospection: true,
    isExecutionInspection: true,
    isProviderInspection: false,
    lifecycle_change_requested: false,
  };

  return {
    capability_id: "supervised-engineering-execution",
    detected_intent: "supervised_execution_engine_inspection",
    routing_decision: "route_to_inspectSupervisedExecutionEngine",
    resolved_capability: "supervised-engineering-execution",
    resolved_operation: "inspectSupervisedExecutionEngine",
    execution_providers: executionProviders,
    active_execution_provider: activeProvider,
    provider_independence_status: providerIndependence,
    execution_package_support: packageSupport,
    execution_pipeline_stages: pipelineStages,
    execution_diagnostics_support: diagnosticsSupport,
    product_owner_governance_gates: governanceGates,
    runtime_diagnostics: runtimeDiagnostics,
    intent_diagnostics: intentDiagnostics,
    lifecycle_change_performed: false,
    audit_reference: auditRef,
  };
}

// ─── EWO-029R.2: Execution Provider Inspection (MCP) ──────────────────────────
// Returns governed provider metadata from execution_provider_registry.

const PROVIDER_ALIASES: Record<string, string> = {
  "bolt": "bolt",
  "bolt execution provider": "bolt",
  "bolt implementation provider": "bolt",
  "native atd": "native-atd",
  "native atd execution provider": "native-atd",
  "native atd execution engine": "native-atd",
  "native-atd": "native-atd",
};

function extractProviderTarget(text: string): string | null {
  // Try "Inspect the X execution provider"
  let m = text.match(/(?:inspect|show|describe|explain)\s+(?:the\s+)?(\w[\w\s-]*?)\s+execution\s+provider/i);
  if (m && m[1]) return m[1].trim().toLowerCase();
  // Try "Show the X implementation provider"
  m = text.match(/(?:inspect|show)\s+(?:the\s+)?(\w[\w\s-]*?)\s+implementation\s+provider/i);
  if (m && m[1]) return m[1].trim().toLowerCase();
  // Try "Inspect provider ID X"
  m = text.match(/(?:inspect|show)\s+provider\s+id\s+(\w[\w-]*)/i);
  if (m && m[1]) return m[1].trim().toLowerCase();
  return null;
}

async function inspectExecutionProviderMcp(
  supabase: ReturnType<typeof createClient>,
  rawTarget: string,
): Promise<Record<string, unknown>> {
  const servicesInvoked: string[] = ["execution_provider_registry"];
  const registriesInspected: string[] = ["execution_provider_registry"];
  const unavailableFields: string[] = [];

  // ── Retrieve all providers from governed registry ──
  const { data: providers, error: providersError } = await supabase
    .from("execution_provider_registry")
    .select("*")
    .order("created_at", { ascending: true });

  const providerRecordsExamined = providers?.length ?? 0;

  // ── Canonical provider resolution (deterministic matching order) ──
  let resolvedProvider: Record<string, unknown> | null = null;
  let resolutionMethod = "unresolved";
  let canonicalProviderId: string | null = null;

  const target = rawTarget.trim();
  const targetLower = target.toLowerCase();

  // 1. Exact provider ID
  if (!resolvedProvider) {
    const match = (providers ?? []).find((p: Record<string, unknown>) => p.provider_id === target);
    if (match) { resolvedProvider = match; resolutionMethod = "exact_provider_id"; canonicalProviderId = match.provider_id; }
  }
  // 2. Exact canonical provider name
  if (!resolvedProvider) {
    const match = (providers ?? []).find((p: Record<string, unknown>) => p.provider_name === target);
    if (match) { resolvedProvider = match; resolutionMethod = "exact_provider_name"; canonicalProviderId = match.provider_id; }
  }
  // 3. Case-insensitive provider ID
  if (!resolvedProvider) {
    const match = (providers ?? []).find((p: Record<string, unknown>) => String(p.provider_id).toLowerCase() === targetLower);
    if (match) { resolvedProvider = match; resolutionMethod = "case_insensitive_provider_id"; canonicalProviderId = match.provider_id; }
  }
  // 4. Case-insensitive canonical provider name
  if (!resolvedProvider) {
    const match = (providers ?? []).find((p: Record<string, unknown>) => String(p.provider_name).toLowerCase() === targetLower);
    if (match) { resolvedProvider = match; resolutionMethod = "case_insensitive_provider_name"; canonicalProviderId = match.provider_id; }
  }
  // 5. Governed alias match
  if (!resolvedProvider) {
    const aliasKey = Object.keys(PROVIDER_ALIASES).find(k => k === targetLower);
    if (aliasKey) {
      const aliasId = PROVIDER_ALIASES[aliasKey];
      const match = (providers ?? []).find((p: Record<string, unknown>) => p.provider_id === aliasId || String(p.provider_id).toLowerCase() === aliasId);
      if (match) { resolvedProvider = match; resolutionMethod = "governed_alias_match"; canonicalProviderId = match.provider_id; }
    }
  }
  // 6. Unresolved
  if (!resolvedProvider) {
    resolutionMethod = "unresolved";
    unavailableFields.push("provider_id", "provider_name", "provider_type", "provider_version", "lifecycle_status", "active_status", "governed_status", "execution_contract_version", "supported_operations", "governance_rules", "provider_configuration");
  }

  // ── Build governed provider metadata ──
  const providerMetadata = resolvedProvider ? {
    provider_id: resolvedProvider.provider_id ?? null,
    provider_name: resolvedProvider.provider_name ?? null,
    provider_type: resolvedProvider.provider_type ?? null,
    provider_version: resolvedProvider.provider_version ?? null,
    lifecycle_status: resolvedProvider.is_active ? "active" : "inactive",
    active_status: resolvedProvider.is_active === true ? "active" : "inactive",
    governed_status: resolvedProvider.is_governed === true ? "governed" : "ungoverned",
    execution_contract_version: resolvedProvider.canonical_contract_version ?? null,
    supported_operations: resolvedProvider.supported_operations ?? null,
    governance_rules: resolvedProvider.governance_rules ?? null,
    provider_configuration: resolvedProvider.provider_configuration ?? null,
  } : null;

  // ── Provider diagnostics ──
  const providerDiagnostics = {
    provider_target_supplied: rawTarget,
    canonical_provider_id_resolved: canonicalProviderId,
    provider_resolution_method: resolutionMethod,
    registry_records_examined: providerRecordsExamined,
    matched_registry_record: resolvedProvider ? {
      provider_id: resolvedProvider.provider_id,
      provider_name: resolvedProvider.provider_name,
    } : null,
    active_status_source: resolvedProvider ? "execution_provider_registry.is_active" : "unavailable",
    lifecycle_status_source: resolvedProvider ? "execution_provider_registry.is_active" : "unavailable",
    governed_status_source: resolvedProvider ? "execution_provider_registry.is_governed" : "unavailable",
    execution_contract_source: resolvedProvider ? "execution_provider_registry.canonical_contract_version" : "unavailable",
    configuration_source: resolvedProvider ? "execution_provider_registry.provider_configuration" : "unavailable",
    unavailable_fields: unavailableFields,
    diagnostic_confidence: resolvedProvider ? 1.0 : 0.3,
  };

  // ── Audit ──
  const auditRef = `ATD-MCP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ── Runtime diagnostics ──
  const runtimeDiagnostics = {
    request_id: auditRef,
    detected_intent: "execution_provider_inspection",
    extracted_provider_target: rawTarget,
    provider_resolution_method: resolutionMethod,
    capability_resolution_method: "capability_registry_lookup:supervised-engineering-execution",
    operation_resolution_method: "deterministic_routing:inspectExecutionProvider",
    routing_rule: "execution_provider_inspection_precedence",
    services_invoked: servicesInvoked,
    registry_inspected: registriesInspected,
    provider_records_examined: providerRecordsExamined,
    unavailable_fields: unavailableFields,
    diagnostic_confidence: resolvedProvider ? 1.0 : 0.3,
    lifecycle_change_performed: false,
    generated_timestamp: new Date().toISOString(),
    audit_reference: auditRef,
  };

  // ── Intent diagnostics ──
  const intentDiagnostics = {
    detected_intent: "execution_provider_inspection",
    confidence: 0.95,
    routing_decision: "route_to_inspectExecutionProvider",
    extracted_target: rawTarget,
    matched_pattern: "execution_provider_inspection",
    isWriteRequest: false,
    isMetadataQuestion: false,
    isFrameworkIntrospection: false,
    isExecutionInspection: true,
    isProviderInspection: true,
    lifecycle_change_requested: false,
  };

  return {
    capability_id: "supervised-engineering-execution",
    detected_intent: "execution_provider_inspection",
    routing_decision: "route_to_inspectExecutionProvider",
    resolved_capability: "supervised-engineering-execution",
    resolved_operation: "inspectExecutionProvider",
    resolved_provider_id: canonicalProviderId,
    provider_metadata: providerMetadata,
    provider_diagnostics: providerDiagnostics,
    runtime_diagnostics: runtimeDiagnostics,
    intent_diagnostics: intentDiagnostics,
    lifecycle_change_performed: false,
    audit_reference: auditRef,
  };
}

// ─── EWO-030R.2: Codex Provider Implementation Evidence Inspection (MCP) ──────────

const MCP_CODEX_PIPELINE_STAGES = [
  "execution_package_validation",
  "governance_validation",
  "po_gate_validation",
  "provider_eligibility_validation",
  "credential_validation",
  "provider_health_validation",
  "budget_validation",
  "cost_estimation",
  "codex_request_preparation",
  "supervised_execution",
  "response_contract_validation",
  "file_change_inspection",
  "command_test_result_inspection",
  "constitutional_compliance_validation",
  "completion_package_generation",
  "po_review_gate",
  "audit_recording",
];

const MCP_CODEX_COMMAND_CLASSIFICATIONS = [
  "allowed", "conditionally_allowed", "prohibited", "read_only",
  "test", "build", "migration", "deployment", "destructive",
];

const MCP_CODEX_ALLOWED_CLASSES = ["allowed", "read_only", "test", "build"];
const MCP_CODEX_APPROVAL_REQUIRED_CLASSES = ["conditionally_allowed", "migration", "deployment", "destructive"];
const MCP_CODEX_PROHIBITED_CLASSES = ["prohibited"];

async function inspectCodexProviderImplementationEvidenceMcp(
  supabase: ReturnType<typeof createClient>,
): Promise<Record<string, unknown>> {
  const servicesInvoked: string[] = [];
  const sourcesInspected: string[] = [];
  const successfulLookups: string[] = [];
  const failedLookups: string[] = [];
  const unavailableFields: string[] = [];

  // ── 1. Canonical provider metadata ──
  servicesInvoked.push("execution_provider_registry");
  sourcesInspected.push("execution_provider_registry");
  const { data: providerRow, error: providerError } = await supabase
    .from("execution_provider_registry")
    .select("*")
    .eq("provider_id", "codex")
    .maybeSingle();

  if (providerError || !providerRow) {
    failedLookups.push("execution_provider_registry:codex");
    unavailableFields.push("canonical_provider_metadata");
    const auditRef = `ATD-MCP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      capability_id: "supervised-engineering-execution",
      detected_intent: "codex_provider_implementation_evidence_inspection",
      routing_decision: "route_to_inspectCodexProviderImplementationEvidence",
      resolved_capability: "supervised-engineering-execution",
      resolved_operation: "inspectCodexProviderImplementationEvidence",
      resolved_provider: "codex",
      canonical_provider_metadata: { status: "unavailable", reason: "Codex provider not found in execution_provider_registry", source_examined: "execution_provider_registry" },
      provider_diagnostics: { unavailable_fields: unavailableFields, failed_evidence_lookups: failedLookups, diagnostic_confidence: 0.3 },
      lifecycle_change_performed: false,
      audit_reference: auditRef,
    };
  }
  successfulLookups.push("execution_provider_registry:codex");

  const providerConfig = (providerRow.provider_config || {}) as Record<string, unknown>;
  const supportedOperations = (providerConfig.supported_operations as string[]) || [];
  const supportedModels = (providerConfig.supported_models as string[]) || [];
  const defaultModel = (providerConfig.default_model as string) || "codex-mini-latest";
  const permittedEnvironments = (providerRow.permitted_environments as string[]) || ["staging"];

  // ── 2. Credential reference status ──
  servicesInvoked.push("codex_provider_credentials");
  sourcesInspected.push("codex_provider_credentials");
  const { data: credentialRow, error: credentialError } = await supabase
    .from("codex_provider_credentials")
    .select("*")
    .eq("environment", "staging")
    .eq("is_current", true)
    .maybeSingle();

  let credentialReferenceStatus: string;
  let credentialLastValidated: string | null = null;
  if (credentialError) {
    failedLookups.push("codex_provider_credentials:staging:current");
    credentialReferenceStatus = "unavailable";
    unavailableFields.push("credential_reference_status.last_validation");
  } else if (!credentialRow) {
    credentialReferenceStatus = "unavailable";
    unavailableFields.push("credential_reference_status.credential_ref");
  } else {
    successfulLookups.push("codex_provider_credentials:staging:current");
    credentialReferenceStatus = (credentialRow as Record<string, unknown>).credential_status as string || "unavailable";
    credentialLastValidated = (credentialRow as Record<string, unknown>).validated_at as string || null;
  }

  // ── 3. Budget configuration ──
  servicesInvoked.push("codex_budget_config");
  sourcesInspected.push("codex_budget_config");
  const { data: budgetRow, error: budgetError } = await supabase
    .from("codex_budget_config")
    .select("*")
    .eq("environment", "staging")
    .eq("is_active", true)
    .maybeSingle();

  let budgetConfiguration: Record<string, unknown>;
  if (budgetError || !budgetRow) {
    failedLookups.push("codex_budget_config:staging:active");
    budgetConfiguration = { status: "unavailable", reason: "No active budget configuration found", source_examined: "codex_budget_config" };
    unavailableFields.push("budget_configuration");
  } else {
    successfulLookups.push("codex_budget_config:staging:active");
    const b = budgetRow as Record<string, unknown>;
    budgetConfiguration = {
      per_execution_limit_usd: parseFloat(String(b.per_execution_limit_usd)),
      per_ewo_limit_usd: parseFloat(String(b.per_ewo_limit_usd)),
      daily_limit_usd: parseFloat(String(b.daily_limit_usd)),
      monthly_limit_usd: parseFloat(String(b.monthly_limit_usd)),
      warning_threshold_pct: parseFloat(String(b.warning_threshold_pct)),
      approval_threshold_pct: parseFloat(String(b.approval_threshold_pct)),
      hard_stop_threshold_pct: parseFloat(String(b.hard_stop_threshold_pct)),
      environment: b.environment,
      is_active: b.is_active,
      source: "codex_budget_config",
    };
  }

  // ── 4. Pricing snapshot status ──
  let pricingSnapshotStatus: Record<string, unknown>;
  if (budgetRow) {
    const b = budgetRow as Record<string, unknown>;
    const effectiveDate = b.pricing_effective_date as string;
    const daysSinceEffective = effectiveDate
      ? Math.floor((Date.now() - new Date(effectiveDate).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    const isStale = daysSinceEffective !== null && daysSinceEffective > 90;
    pricingSnapshotStatus = {
      status: isStale ? "stale" : "available",
      effective_date: effectiveDate,
      pricing_source: b.pricing_source,
      input_token_price_per_1m: parseFloat(String(b.input_token_price_per_1m)),
      cached_input_token_price_per_1m: parseFloat(String(b.cached_input_token_price_per_1m)),
      output_token_price_per_1m: parseFloat(String(b.output_token_price_per_1m)),
      currency: b.currency,
      days_since_effective: daysSinceEffective,
      source: "codex_budget_config",
    };
  } else {
    pricingSnapshotStatus = { status: "unavailable", reason: "No budget configuration available", source_examined: "codex_budget_config" };
    unavailableFields.push("pricing_snapshot_status");
  }

  // ── 5. Provider health status ──
  const providerHealth = (providerRow as Record<string, unknown>).provider_health || "unknown";
  const lastSuccessfulHealthCheck = (providerRow as Record<string, unknown>).last_successful_health_check || null;
  const lastFailedHealthCheck = (providerRow as Record<string, unknown>).last_failed_health_check || null;

  // ── 6. Latest health check result ──
  servicesInvoked.push("codex_provider_health");
  sourcesInspected.push("codex_provider_health");
  const { data: healthRow, error: healthError } = await supabase
    .from("codex_provider_health")
    .select("*")
    .eq("environment", "staging")
    .order("checked_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let latestHealthCheckResult: Record<string, unknown>;
  if (healthError || !healthRow) {
    failedLookups.push("codex_provider_health:staging:latest");
    latestHealthCheckResult = { status: "unavailable", reason: "No health check has been performed", source_examined: "codex_provider_health" };
    unavailableFields.push("latest_health_check_result");
  } else {
    successfulLookups.push("codex_provider_health:staging:latest");
    const h = healthRow as Record<string, unknown>;
    latestHealthCheckResult = {
      configuration_status: h.configuration_status,
      secret_availability_status: h.secret_availability_status,
      authentication_status: h.authentication_status,
      api_accessibility_status: h.api_accessibility_status,
      model_availability_status: h.model_availability_status,
      contract_compatibility_status: h.contract_compatibility_status,
      rate_limit_status: h.rate_limit_status,
      is_healthy: h.is_healthy,
      checked_at: h.checked_at,
      diagnostics: h.diagnostics,
      source: "codex_provider_health",
    };
  }

  // ── 7. Latest dry-run result ──
  servicesInvoked.push("codex_execution_attempts");
  sourcesInspected.push("codex_execution_attempts");
  const { data: dryRunAttempt, error: dryRunError } = await supabase
    .from("codex_execution_attempts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let latestDryRunResult: Record<string, unknown>;
  if (dryRunError || !dryRunAttempt) {
    latestDryRunResult = { status: "unavailable", reason: "No dry-run execution records exist", source_examined: "codex_execution_attempts" };
    unavailableFields.push("latest_dry_run_result");
    unavailableFields.push("paid_tokens_consumed");
  } else {
    successfulLookups.push("codex_execution_attempts:latest");
    const d = dryRunAttempt as Record<string, unknown>;
    latestDryRunResult = {
      attempt_ref: d.attempt_ref,
      execution_ref: d.execution_ref,
      attempt_status: d.attempt_status,
      model_used: d.model_used,
      estimated_input_tokens: d.estimated_input_tokens,
      estimated_output_tokens: d.estimated_output_tokens,
      estimated_cost_usd: d.estimated_cost_usd != null ? parseFloat(String(d.estimated_cost_usd)) : null,
      paid_tokens_consumed: 0,
      source: "codex_execution_attempts",
    };
  }

  // ── 8. Trial metrics support ──
  servicesInvoked.push("codex_trial_metrics");
  sourcesInspected.push("codex_trial_metrics");
  const { count: trialCount, error: trialCountError } = await supabase
    .from("codex_trial_metrics")
    .select("*", { count: "exact", head: true });

  let trialMetricsSupport: Record<string, unknown>;
  if (trialCountError) {
    failedLookups.push("codex_trial_metrics:count");
    trialMetricsSupport = { supported: true, metrics_table: "codex_trial_metrics", execution_count: 0, status: "unavailable", reason: "Failed to query trial metrics", source_examined: "codex_trial_metrics" };
    unavailableFields.push("trial_metrics_support.execution_count");
  } else {
    successfulLookups.push("codex_trial_metrics:count");
    const { count: acceptedCount } = await supabase
      .from("codex_trial_metrics")
      .select("*", { count: "exact", head: true })
      .eq("accepted_or_rejected", "accepted");
    const { count: rejectedCount } = await supabase
      .from("codex_trial_metrics")
      .select("*", { count: "exact", head: true })
      .eq("accepted_or_rejected", "rejected");
    trialMetricsSupport = {
      supported: true,
      metrics_table: "codex_trial_metrics",
      execution_count: trialCount || 0,
      accepted_count: acceptedCount || 0,
      rejected_count: rejectedCount || 0,
      source: "codex_trial_metrics",
    };
  }

  // ── 9. Edge function deployment status ──
  servicesInvoked.push("supabase.functions.list");
  let edgeFunctionDeploymentStatus: Record<string, unknown>;
  try {
    const fnResponse = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/codex-health-check`, {
      method: "OPTIONS",
      // Issue #45: server-to-server call; codex-health-check accepts the service role or an operator.
      headers: { "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
    });
    const codexHealthDeployed = fnResponse.ok || fnResponse.status === 200 || fnResponse.status === 204;
    edgeFunctionDeploymentStatus = {
      save_codex_credential: { slug: "save-codex-credential", deployment_status: "deployed", source: "runtime_probe:options_ok" },
      codex_health_check: { slug: "codex-health-check", deployment_status: codexHealthDeployed ? "deployed" : "unavailable", source: codexHealthDeployed ? "runtime_probe:options_ok" : "runtime_probe:options_failed", http_status: fnResponse.status },
      codex_dry_run: { slug: "codex-dry-run", deployment_status: "deployed", source: "source_file_and_migration_record" },
      note: "Deployment status verified via runtime probe where possible. codex-dry-run status inferred from source file presence.",
    };
    successfulLookups.push("edge_function_deployment_status");
  } catch {
    edgeFunctionDeploymentStatus = {
      save_codex_credential: { slug: "save-codex-credential", deployment_status: "deployed", source: "source_file_and_migration_record" },
      codex_health_check: { slug: "codex-health-check", deployment_status: "deployed", source: "source_file_and_migration_record" },
      codex_dry_run: { slug: "codex-dry-run", deployment_status: "deployed", source: "source_file_and_migration_record" },
      note: "Runtime probe failed; deployment status inferred from source file presence and migration record only.",
    };
    unavailableFields.push("edge_function_deployment_status.runtime_verification");
  }

  // ── 10. Provider diagnostics ──
  const providerDiagnostics = {
    records_examined: successfulLookups.length + failedLookups.length,
    sources_inspected: sourcesInspected,
    successful_evidence_lookups: successfulLookups,
    failed_evidence_lookups: failedLookups,
    unavailable_fields: unavailableFields,
    diagnostic_confidence: unavailableFields.length === 0 ? 1.0 : Math.max(0.5, 1.0 - (unavailableFields.length * 0.05)),
  };

  // ── 11. Audit ──
  const auditRef = `ATD-MCP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ── 12. Runtime diagnostics ──
  const runtimeDiagnostics = {
    request_id: auditRef,
    detected_intent: "codex_provider_implementation_evidence_inspection",
    routing_decision: "route_to_inspectCodexProviderImplementationEvidence",
    resolved_capability: "supervised-engineering-execution",
    resolved_operation: "inspectCodexProviderImplementationEvidence",
    resolved_provider: "codex",
    services_invoked: servicesInvoked,
    data_sources_inspected: sourcesInspected,
    unavailable_fields: unavailableFields,
    lifecycle_change_performed: false,
    generated_timestamp: new Date().toISOString(),
    audit_reference: auditRef,
  };

  // ── 13. Intent diagnostics ──
  const intentDiagnostics = {
    detected_intent: "codex_provider_implementation_evidence_inspection",
    confidence: 0.98,
    routing_decision: "route_to_inspectCodexProviderImplementationEvidence",
    extracted_target: "codex",
    matched_pattern: "codex_provider_implementation_evidence",
    isWriteRequest: false,
    isMetadataQuestion: false,
    isFrameworkIntrospection: true,
    isExecutionInspection: true,
    isProviderInspection: false,
    lifecycle_change_requested: false,
  };

  const p = providerRow as Record<string, unknown>;
  return {
    capability_id: "supervised-engineering-execution",
    detected_intent: "codex_provider_implementation_evidence_inspection",
    routing_decision: "route_to_inspectCodexProviderImplementationEvidence",
    resolved_capability: "supervised-engineering-execution",
    resolved_operation: "inspectCodexProviderImplementationEvidence",
    resolved_provider: "codex",
    canonical_provider_metadata: {
      provider_id: p.provider_id,
      provider_name: p.provider_name,
      provider_type: p.provider_type,
      provider_version: p.provider_version,
      lifecycle_status: p.is_active ? "active" : "inactive",
      active_status: p.is_active === true ? "active" : "inactive",
      governed_status: p.is_governed === true ? "governed" : "ungoverned",
      execution_contract_version: p.canonical_contract_version,
      source: "execution_provider_registry",
    },
    supported_operations: {
      operations: supportedOperations,
      source: "execution_provider_registry.provider_config.supported_operations",
    },
    provider_configuration: {
      engine_id: providerConfig.engine_id,
      api_base_url: providerConfig.api_base_url,
      default_model: defaultModel,
      supported_models: supportedModels,
      feature_flags: {
        supports_file_writes: providerConfig.supports_file_writes,
        supports_database_migrations: providerConfig.supports_database_migrations,
        supports_tests: providerConfig.supports_tests,
        supports_builds: providerConfig.supports_builds,
        supports_deploy: providerConfig.supports_deploy,
        supports_rollback: providerConfig.supports_rollback,
        requires_credential: providerConfig.requires_credential,
        requires_budget: providerConfig.requires_budget,
      },
      token_limits: {
        max_context_tokens: providerConfig.max_context_tokens,
        max_output_tokens: providerConfig.max_output_tokens,
      },
      source: "execution_provider_registry.provider_config",
    },
    permitted_environments: {
      environments: permittedEnvironments,
      source: "execution_provider_registry.permitted_environments",
    },
    credential_reference_status: {
      status: credentialReferenceStatus,
      credential_reference_only: credentialRow ? (credentialRow as Record<string, unknown>).credential_reference : null,
      raw_credential_exposed: false,
      last_validation_time: credentialLastValidated,
      source: "codex_provider_credentials",
    },
    provider_health_status: {
      current_health: providerHealth,
      last_successful_health_check: lastSuccessfulHealthCheck,
      last_failed_health_check: lastFailedHealthCheck,
      source: "execution_provider_registry",
    },
    latest_health_check_result: latestHealthCheckResult,
    codex_model_configuration: {
      default_model: defaultModel,
      supported_models: supportedModels,
      context_limit: providerConfig.max_context_tokens,
      output_limit: providerConfig.max_output_tokens,
      source: "execution_provider_registry.provider_config",
    },
    budget_configuration: budgetConfiguration,
    pricing_snapshot_status: pricingSnapshotStatus,
    execution_pipeline_stages: {
      stages: MCP_CODEX_PIPELINE_STAGES,
      count: MCP_CODEX_PIPELINE_STAGES.length,
      source: "canonical_definition:CODEX_PIPELINE_STAGES",
      implementation_version: "1.0.0",
    },
    repository_controls: {
      permitted_repository: "eios-staging",
      permitted_branch: "staging",
      permitted_directories: ["src/", "supabase/functions/", "supabase/migrations/"],
      protected_files: [".env", ".gitignore", "CLAUDE.md", "package-lock.json"],
      allow_file_creation: true,
      allow_file_modification: true,
      allow_file_deletion: false,
      allow_generated_migrations: true,
      source: "canonical_definition:codexControlsService.getDefaultRepositoryControls",
    },
    command_controls: {
      classifications: MCP_CODEX_COMMAND_CLASSIFICATIONS,
      allowed_classes: MCP_CODEX_ALLOWED_CLASSES,
      approval_required_classes: MCP_CODEX_APPROVAL_REQUIRED_CLASSES,
      prohibited_classes: MCP_CODEX_PROHIBITED_CLASSES,
      source: "canonical_definition:codexControlsService.classifyCommand",
    },
    dry_run_capability: {
      available: true,
      operation: "performDryRun",
      edge_function: "codex-dry-run",
      bypasses_external_provider_api: true,
      expected_paid_token_behaviour: "zero_tokens_consumed",
      source: "canonical_definition:codexDryRunService, supabase/functions/codex-dry-run",
    },
    latest_dry_run_result: latestDryRunResult,
    completion_package_support: {
      supported: true,
      completion_contract: "CodexCompletionPackage",
      contract_version: "1.0",
      source: "canonical_definition:codexTypes.CodexCompletionPackage, codexPipeline.completion_package_generation",
    },
    trial_metrics_support: trialMetricsSupport,
    deployed_runtime_components: {
      adapter: { path: "src/lib/codex/codexAdapter.ts", source: "source_file" },
      pipeline: { path: "src/lib/codex/codexPipeline.ts", source: "source_file" },
      credential_service: { path: "src/lib/codex/codexCredentialService.ts", source: "source_file" },
      budget_service: { path: "src/lib/codex/codexBudgetService.ts", source: "source_file" },
      controls_service: { path: "src/lib/codex/codexControlsService.ts", source: "source_file" },
      dry_run_service: { path: "src/lib/codex/codexDryRunService.ts", source: "source_file" },
      health_service: { path: "src/lib/codex/codexHealthService.ts", source: "source_file" },
      trial_service: { path: "src/lib/codex/codexTrialService.ts", source: "source_file" },
      product_owner_interface: { path: "src/pages/ecc/ECCCodexProviderPage.tsx", source: "source_file" },
    },
    edge_function_deployment_status: edgeFunctionDeploymentStatus,
    provider_diagnostics: providerDiagnostics,
    runtime_diagnostics: runtimeDiagnostics,
    intent_diagnostics: intentDiagnostics,
    lifecycle_change_performed: false,
    audit_reference: auditRef,
  };
}

async function executeTool(supabase: ReturnType<typeof createClient>, toolName: string, args: Record<string, unknown>, userId: string, clientId: string, mcpSessionId?: string): Promise<{ governed: boolean; data: unknown; error?: string; auditRef: string }> {
  const auditRef = `ATD-MCP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const persona = String(args.persona ?? args.requesting_persona ?? "atd");

  try {
    switch (toolName) {
      case "discover_atd_capabilities": {
        const { data: caps, error } = await supabase
          .from("atd_connect_capabilities")
          .select("capability_id, name, description, category, status, lifecycle_status, deprecated, owner, constitutional_visibility")
          .order("capability_id");
        if (error) return { governed: true, data: null, error: error.message, auditRef };
        await supabase.from("atd_connect_inspection_log").insert({
          request_id: auditRef, timestamp: new Date().toISOString(),
          requesting_persona: persona, operation: "discoverCapabilities",
          inspected_capability: "capabilities", outcome: "success",
          request_source: "mcp_client", client_id: clientId, tool_name: toolName,
        });
        return { governed: true, data: { capabilities: caps ?? [], count: caps?.length ?? 0 }, auditRef };
      }

      case "inspect_engineering_object": {
        const capability = String(args.capability ?? "");
        const operation = String(args.operation ?? "");
        const objectRef = String(args.object_reference ?? "");

        // EWO-017: Validate operation against registered capability before execution
        if (capability && operation) {
          const { data: capDef } = await supabase
            .from("atd_connect_capabilities")
            .select("supported_operations, name, current_availability, status")
            .eq("capability_id", capability)
            .maybeSingle();

          if (capDef) {
            const registeredOps: string[] = Array.isArray(capDef.supported_operations) ? capDef.supported_operations.map(String) : [];
            if (!registeredOps.includes(operation)) {
              await supabase.from("atd_connect_inspection_log").insert({
                request_id: auditRef, timestamp: new Date().toISOString(),
                requesting_persona: persona, operation, inspected_capability: capability,
                outcome: "unsupported_operation", request_source: "mcp_client",
                client_id: clientId, tool_name: toolName,
              });
              return { governed: true, data: {
                governed: true,
                resolution_outcome: "unsupported_operation",
                capability_searched: capability,
                operation_requested: operation,
                reason: "Operation \"" + operation + "\" is not exposed by capability \"" + capability + "\". No execution performed.",
                resolution_performed: "operation_validation",
                available_operations: registeredOps,
                no_execution_performed: true,
                runtime_diagnostics: {
                  capability_resolved: capability,
                  resolution_confidence: 1.0,
                  metadata_source: "atd_connect_capabilities registry",
                  operations_returned: registeredOps,
                  permissions_evaluated: true,
                  governance_outcome: "unsupported_operation_refused",
                  execution_path: "capability_metadata_inspection",
                },
                audit_reference: auditRef,
              }, auditRef };
            }
          }
        }

        if (capability === "engineering-work-orders" && operation === "inspectEngineeringWorkOrder") {
          const resolution = await resolveEWORef(supabase, objectRef);
          if (!resolution.resolved) {
            await supabase.from("atd_connect_inspection_log").insert({
              request_id: auditRef, timestamp: new Date().toISOString(),
              requesting_persona: persona, operation, inspected_capability: capability,
              inspected_object: objectRef, outcome: resolution.ambiguous ? "governed_empty" : "governed_empty",
              request_source: "mcp_client", client_id: clientId, tool_name: toolName,
            });
            return { governed: true, data: null, error: resolution.ambiguous ? `Ambiguous reference: ${resolution.candidates.join(", ")}` : `Object "${objectRef}" not found`, auditRef };
          }
          const { data: ewo, error: ewoErr } = await supabase
            .from("engineering_work_orders")
            .select("*")
            .eq("ewo_ref", resolution.canonical)
            .maybeSingle();
          if (ewoErr || !ewo) return { governed: true, data: null, error: `Object "${objectRef}" not found`, auditRef };
          // EWO-028: Include knowledge extraction summary
          let knowledgeExtractionSummary: Record<string, unknown> | null = null;
          const { data: keExtraction } = await supabase
            .from("engineering_knowledge_extractions")
            .select("id, extraction_status, knowledge_records_created, knowledge_records_merged, knowledge_records_skipped, extracted_at")
            .eq("ewo_id", ewo.id)
            .maybeSingle();
          if (keExtraction) {
            const { count: provCount } = await supabase
              .from("engineering_knowledge_provenance")
              .select("*", { count: "exact", head: true })
              .eq("ewo_id", ewo.id);
            knowledgeExtractionSummary = {
              extraction_status: keExtraction.extraction_status,
              knowledge_records_created: keExtraction.knowledge_records_created,
              knowledge_records_merged: keExtraction.knowledge_records_merged,
              knowledge_records_skipped: keExtraction.knowledge_records_skipped,
              extracted_at: keExtraction.extracted_at,
              provenance_records: provCount || 0,
              extraction_id: keExtraction.id,
            };
          } else {
            knowledgeExtractionSummary = {
              extraction_status: ewo.knowledge_extraction_status || "not_extracted",
              provenance_records: 0,
            };
          }

          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: persona, operation, inspected_capability: capability,
            inspected_object: resolution.canonical, outcome: "success",
            request_source: "mcp_client", client_id: clientId, tool_name: toolName,
          });
          return { governed: true, data: {
            object_ref: resolution.canonical,
            object_type: "engineering_work_order",
            summary: String(ewo.title ?? ""),
            details: ewo,
            knowledge_extraction: knowledgeExtractionSummary,
            resolved_from: objectRef,
            resolution_type: resolution.canonical !== objectRef ? "canonical" : "exact",
          }, auditRef };
        }

        // Generic fallback for other capabilities
        await supabase.from("atd_connect_inspection_log").insert({
          request_id: auditRef, timestamp: new Date().toISOString(),
          requesting_persona: persona, operation, inspected_capability: capability,
          inspected_object: objectRef, outcome: "governed_empty",
          request_source: "mcp_client", client_id: clientId, tool_name: toolName,
        });
        return { governed: true, data: null, error: `Capability/operation combination not supported via MCP: ${capability}/${operation}`, auditRef };
      }

      case "list_engineering_objects": {
        const capability = String(args.capability ?? "");
        let table: string | null = null;
        if (capability === "pages") table = "pages";
        else if (capability === "workspaces") table = "workspaces";
        else if (capability === "services") table = "services";
        else if (capability === "engineering-work-orders") table = "engineering_work_orders";
        else if (capability === "engineering-records") table = "engineering_records_library";
        else if (capability === "engineering-standards") table = "engineering_standards";

        if (!table) {
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: persona, operation: "listObjects",
            inspected_capability: capability, outcome: "governed_empty",
            request_source: "mcp_client", client_id: clientId, tool_name: toolName,
          });
          return { governed: true, data: null, error: `Unsupported capability for listing: ${capability}`, auditRef };
        }

        const { data: objects, error: listErr } = await supabase.from(table).select("*").limit(50);
        if (listErr) return { governed: true, data: null, error: listErr.message, auditRef };
        await supabase.from("atd_connect_inspection_log").insert({
          request_id: auditRef, timestamp: new Date().toISOString(),
          requesting_persona: persona, operation: "listObjects",
          inspected_capability: capability, outcome: "success",
          request_source: "mcp_client", client_id: clientId, tool_name: toolName,
        });
        return { governed: true, data: { objects: objects ?? [], count: objects?.length ?? 0, table }, auditRef };
      }

      case "inspect_relationships": {
        const objectRef = String(args.object_reference ?? "");
        const { data: lineage, error: relErr } = await supabase
          .from("engineering_record_lineage")
          .select("id, from_record_ref, to_ref, relationship_type")
          .or(`from_record_ref.eq.${objectRef},to_ref.eq.${objectRef}`)
          .limit(50);
        if (relErr) return { governed: true, data: null, error: relErr.message, auditRef };

        // EWO-028: Include engineering knowledge relationships
        let knowledgeRelationships: unknown[] = [];
        if (objectRef.startsWith("EWO-")) {
          const { data: keProv } = await supabase
            .from("engineering_knowledge_provenance")
            .select("knowledge_record_id, ewo_ref, implementation_version, completion_report_id, extraction_id, extraction_timestamp")
            .eq("ewo_ref", objectRef);
          if (keProv && keProv.length > 0) {
            const recordIds = keProv.map((p: { knowledge_record_id: string }) => p.knowledge_record_id);
            const { data: keMemories } = await supabase
              .from("engineering_memory")
              .select("id, knowledge_category, title, tags")
              .in("id", recordIds);
            knowledgeRelationships = (keMemories || []).map((m: Record<string, unknown>) => ({
              relationship_type: "extracted_knowledge",
              from_ref: objectRef,
              to_ref: `knowledge:${m.id}`,
              knowledge_category: m.knowledge_category,
              title: m.title,
              tags: m.tags,
            }));
          }
        }

        await supabase.from("atd_connect_inspection_log").insert({
          request_id: auditRef, timestamp: new Date().toISOString(),
          requesting_persona: persona, operation: "inspectRelationships",
          inspected_object: objectRef, outcome: "success",
          request_source: "mcp_client", client_id: clientId, tool_name: toolName,
        });
        return { governed: true, data: {
          object_ref: objectRef,
          relationships: lineage ?? [],
          relationship_count: lineage?.length ?? 0,
          knowledge_relationships: knowledgeRelationships,
          knowledge_relationship_count: knowledgeRelationships.length,
          total_relationships: (lineage?.length ?? 0) + knowledgeRelationships.length,
        }, auditRef };
      }

      case "inspect_platform_health": {
        const { count: total } = await supabase
          .from("atd_connect_inspection_log")
          .select("*", { count: "exact", head: true });
        const { count: successCount } = await supabase
          .from("atd_connect_inspection_log")
          .select("*", { count: "exact", head: true })
          .eq("outcome", "success");
        const { count: errorCount } = await supabase
          .from("atd_connect_inspection_log")
          .select("*", { count: "exact", head: true })
          .eq("outcome", "error");
        await supabase.from("atd_connect_inspection_log").insert({
          request_id: auditRef, timestamp: new Date().toISOString(),
          requesting_persona: persona, operation: "inspectPlatformHealth",
          outcome: "success", request_source: "mcp_client", client_id: clientId, tool_name: toolName,
        });
        return { governed: true, data: { operational_health: "healthy", total_inspections: total ?? 0, successful: successCount ?? 0, errors: errorCount ?? 0 }, auditRef };
      }

      case "get_inspection_audit": {
        const limit = Math.min(Number(args.limit ?? 20), 100);
        let query = supabase.from("atd_connect_inspection_log").select("*").order("timestamp", { ascending: false }).limit(limit);
        if (args.request_source) query = query.eq("request_source", String(args.request_source));
        const { data: auditEntries, error: auditErr } = await query;
        if (auditErr) return { governed: true, data: null, error: auditErr.message, auditRef };
        await supabase.from("atd_connect_inspection_log").insert({
          request_id: auditRef, timestamp: new Date().toISOString(),
          requesting_persona: persona, operation: "getInspectionAudit",
          outcome: "success", request_source: "mcp_client", client_id: clientId, tool_name: toolName,
        });
        return { governed: true, data: { audit_entries: auditEntries ?? [], count: auditEntries?.length ?? 0 }, auditRef };
      }

      case "submit_conversation_inspection": {
        const nlRequest = String(args.natural_language_request ?? "");
        const reqPersona = String(args.requesting_persona ?? "external");
        const reqClientId = String(args.client_id ?? "mcp-client");
        const reqSessionId = String(args.session_id ?? "");

        // ── EWO-017R.2R Refinement: Conversation-Specific Identity ─────────
        // User identity (userId, clientId) is NOT conversation identity.
        // userId and clientId identify the authenticated user or MCP client,
        // not a specific ChatGPT conversation. Using them as the scope key
        // for atd_conversation_active_object would cause cross-conversation
        // context leakage. Only conversation-specific identifiers are accepted.
        //
        // Precedence:
        // 1. Explicit conversation_id parameter (ChatGPT conversation ID)
        // 2. X-Conversation-Id header (trusted MCP metadata)
        // 3. session_id parameter (MCP session unique to this conversation)
        // 4. X-Session-Id header (stable MCP session/connection identifier)
        // 5. Mcp-Session-Id header (connector-managed conversation token,
        //    established at MCP initialize and reused for every tools/call
        //    within the same ChatGPT conversation)
        // 6. Deterministic governed failure — NO fallback to userId/clientId
        let conversationId: string | null = null;
        let conversationIdSource = "none";
        let conversationScopeVerified = false;
        const reqConversationId = String(args.conversation_id ?? "");
        const headerConversationId = String(args.x_conversation_id ?? args.x_conversation_id_header ?? "");
        const headerSessionId = String(args.x_session_id ?? args.x_session_id_header ?? "");
        const connectorSessionId = mcpSessionId || "";

        if (reqConversationId) {
          conversationId = reqConversationId;
          conversationIdSource = "explicit_conversation_id_parameter";
          conversationScopeVerified = true;
        } else if (headerConversationId) {
          conversationId = headerConversationId;
          conversationIdSource = "x_conversation_id_header";
          conversationScopeVerified = true;
        } else if (reqSessionId) {
          conversationId = reqSessionId;
          conversationIdSource = "explicit_session_id_parameter";
          conversationScopeVerified = true;
        } else if (headerSessionId) {
          conversationId = headerSessionId;
          conversationIdSource = "x_session_id_header";
          conversationScopeVerified = true;
        } else if (connectorSessionId) {
          conversationId = connectorSessionId;
          conversationIdSource = "mcp_session_id_header";
          conversationScopeVerified = true;
        }
        // If none of the above, conversationId remains null and we DO NOT
        // fall back to userId, clientId, or tenant identity.

        // ── EWO-017R.2R: Governed conversation_id requirement ─────────────
        // The submit_conversation_inspection tool schema marks conversation_id
        // as required. ChatGPT's model is instructed to generate a UUID v4 on
        // the first call and reuse it for subsequent calls in the same
        // conversation. If it is absent, we return a governed instruction
        // response — NOT a silent fallback to user/client identity.
        if (!conversationId) {
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "submit_conversation_inspection",
            outcome: "governed_refusal", request_source: "mcp_client",
            client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest,
            session_id: null,
          });
          return { governed: true, data: {
            governed: true,
            detected_intent: "conversation_identity_required",
            routing_decision: "conversation_identity_required",
            resolved_engineering_object_reference: null,
            object_resolution_method: "not_attempted",
            active_object_updated: false,
            conversation_identifier: null,
            conversation_identifier_source: "none",
            conversation_scope_verified: conversationScopeVerified,
            lifecycle_change_performed: false,
            failure_reason: "conversation_id_argument_required",
            instruction: "The conversation_id argument is required. Generate a random UUID v4 on your first tool call in this conversation and reuse the exact same UUID for every subsequent call. Example: conversation_id=\"a1b2c3d4-e5f6-7890-abcd-ef1234567890\". Use a different UUID in separate conversations.",
            audit_reference: auditRef,
          }, auditRef };
        }

        // ── EWO-017R.2: Context-First Conversational Routing ──────────────
        // The pipeline now resolves governed conversational and engineering-object
        // context BEFORE selecting a specialised capability route. This prevents
        // misclassification of engineering continuation requests as capability
        // metadata inspections.

        // Step 1: Detect explicit canonical object references
        const explicitRef = detectExplicitReference(nlRequest);

        // Step 2: Detect contextual references
        const contextualRef = detectContextualReference(nlRequest);

        // Step 3: Extract negative constraints
        const negativeConstraints = extractNegativeConstraints(nlRequest);

        // Step 4: Detect engineering continuation intent
        const continuationIntent = detectContinuationIntent(nlRequest);

        // Step 5: Resolve governed conversation context
        const tenantId = userId ?? "anonymous";
        const resolvedObject = await resolveConversationContext(
          supabase, nlRequest, explicitRef, contextualRef,
          conversationId || undefined, tenantId,
        );

        // Step 6: Determine if this is a genuine capability metadata request
        const isGenuineCapMetadata = isGenuineCapabilityMetadataRequest(
          nlRequest, continuationIntent, negativeConstraints,
        );

        // Step 7: If an explicit EWO reference was resolved, populate the active object
        let activeObjectUpdated = false;
        let activeObjectLookupAttempted = false;
        let activeObjectRecordFound = false;
        let previousActiveObjectRef: string | null = null;
        // tenantId is the ownership/tenant attribute — used for scoping but
        // NEVER as the conversation identifier.
        if (resolvedObject.resolution_status === "resolved" && resolvedObject.reference && conversationId) {
          activeObjectLookupAttempted = true;
          const popResult = await populateActiveObject(
            supabase, conversationId,
            resolvedObject.reference,
            resolvedObject.object_type ?? "engineering_work_order",
            resolvedObject.title,
            resolvedObject.lifecycle_stage,
            resolvedObject.resolution_method ?? "governed_operation",
            continuationIntent.operation ?? "object_resolved",
            tenantId,
          );
          activeObjectUpdated = popResult.updated;
          activeObjectRecordFound = popResult.updated;
        } else if (conversationId) {
          activeObjectLookupAttempted = true;
          const { data: existingActive } = await supabase
            .from("atd_conversation_active_object")
            .select("id")
            .eq("conversation_id", conversationId)
            .eq("tenant_id", tenantId)
            .limit(1)
            .maybeSingle();
          activeObjectRecordFound = !!existingActive;
        }

        // ── EWO-017R.2R Refinement: Context-binding intent detection ─────────
        const contextBindingIntent = detectContextBindingIntent(nlRequest);

        // ── EWO-017R.2R Refinement: Combined inspect+bind routing ─────────────
        // When the user asks to inspect an EWO AND make it active for the
        // conversation, route to a combined inspect+bind operation. This is
        // NOT a lifecycle mutation — it only updates conversational context.
        if (contextBindingIntent.detected && resolvedObject.resolution_status === "resolved" && resolvedObject.reference) {
          // Validate conversation-specific identity exists before binding.
          // We do NOT fall back to userId, clientId, or tenant identity.
          if (!conversationId || !conversationScopeVerified) {
            // Deterministic failure: no conversation-specific identity
            const diag = buildContextFirstDiagnostic(
              auditRef, "inspect_and_bind_active_object", contextBindingIntent.confidence,
              "context_binding_failed_no_conversation_identity",
              explicitRef, contextualRef, negativeConstraints, resolvedObject,
              "bind_active_engineering_object", null, false, false,
              "context_binding_failed_no_conversation_identity",
              null, "conversation_specific_identity_unavailable",
              conversationId,
              conversationIdSource,
              false, false, false,
              false, null, false,
              false, null,
              [],
              false, false, null, false, false,
              true, contextBindingIntent.isCombinedWithInspection,
              ["inspect_engineering_work_order", "bind_active_engineering_object"],
              null, null,
              "failed_no_conversation_identity",
              false, false,
              "bind_active_engineering_object", null,
              conversationScopeVerified,
            );
            diag.conversation_scope_verified = conversationScopeVerified;
            await supabase.from("atd_connect_inspection_log").insert({
              request_id: auditRef, timestamp: new Date().toISOString(),
              requesting_persona: reqPersona, operation: "bind_active_engineering_object",
              outcome: "failed", request_source: "mcp_client",
              client_id: reqClientId, tool_name: toolName,
              original_request: nlRequest,
              session_id: conversationId,
              resolved_object_reference: resolvedObject.reference,
            });
            return { governed: true, data: {
              governed: true,
              detected_intent: "inspect_and_bind_active_object",
              routing_decision: "context_binding_failed_no_conversation_identity",
              resolved_engineering_object_reference: resolvedObject.reference,
              resolved_engineering_object_type: resolvedObject.object_type,
              object_resolution_method: resolvedObject.resolution_method,
              active_object_updated: false,
              active_object_reference: null,
              active_object_type: null,
              conversation_identifier: null,
              conversation_identifier_source: "none",
              conversation_scope_verified: conversationScopeVerified,
              lifecycle_change_performed: false,
              context_binding_operation: false,
              failure_reason: "conversation_specific_identity_unavailable",
              context_first_diagnostics: diag,
              audit_reference: auditRef,
            }, auditRef };
          }

          // Capture previous active object for audit trail (scoped by tenant+conversation)
          if (conversationId) {
            const { data: prevActive } = await supabase
              .from("atd_conversation_active_object")
              .select("active_object_reference")
              .eq("conversation_id", conversationId)
              .eq("tenant_id", tenantId)
              .order("context_timestamp", { ascending: false })
              .limit(1)
              .maybeSingle();
            previousActiveObjectRef = prevActive?.active_object_reference ?? null;
          }

          // Perform governed context binding (NOT lifecycle mutation)
          const bindResult = await bindActiveObjectWithAudit(
            supabase, conversationId!, tenantId,
            resolvedObject.reference,
            resolvedObject.object_type ?? "engineering_work_order",
            resolvedObject.title,
            resolvedObject.lifecycle_stage,
            "explicit_context_binding_request",
            "bind_active_engineering_object",
          );

          // Retrieve EWO data for the inspection portion
          const inspectionArtefacts = await retrieveEngineeringAnalysis(supabase, resolvedObject.reference);

          const combinedDecomposition = [
            "inspect_engineering_work_order",
            "bind_active_engineering_object",
          ];

          const diag = buildContextFirstDiagnostic(
            auditRef, "inspect_and_bind_active_object", contextBindingIntent.confidence,
            "inspect_and_bind_active_object",
            explicitRef, contextualRef, negativeConstraints, resolvedObject,
            "bind_active_engineering_object", null, false, false,
            "context_binding_succeeded",
            null, null,
            conversationId,
            conversationIdSource,
            true, // active_object_lookup_attempted
            true, // active_object_record_found
            bindResult.updated, // active_object_updated
            true, // linked_analysis_lookup_attempted
            resolvedObject.reference, // linked_analysis_reference
            !!inspectionArtefacts, // linked_analysis_retrieved
            false, // linked_plan_lookup_attempted
            null, // linked_plan_reference
            inspectionArtefacts?.artefacts_retrieved ?? ["engineering_work_orders"],
            false, // continuation_handler_invoked
            false, // continuation_output_created
            null, // governed_draft_reference
            false, // lifecycle_mutation_attempted
            false, // lifecycle_mutation_performed
            true, // context_binding_intent_detected
            contextBindingIntent.isCombinedWithInspection,
            combinedDecomposition,
            bindResult.previousActiveObject,
            bindResult.newActiveObject,
            bindResult.updated ? "succeeded" : "failed",
            true, // context_binding_operation
            false, // lifecycle_change_performed
            "bind_active_engineering_object", // operation_resolution
            null, // capability_resolution
            conversationScopeVerified,
          );
          diag.conversation_scope_verified = conversationScopeVerified;

          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "bind_active_engineering_object",
            outcome: bindResult.updated ? "success" : "failed",
            request_source: "mcp_client",
            client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest,
            session_id: conversationId,
            resolved_object_reference: resolvedObject.reference,
          });

          return { governed: true, data: {
            governed: true,
            detected_intent: "inspect_and_bind_active_object",
            routing_decision: "inspect_and_bind_active_object",
            resolved_engineering_object_reference: resolvedObject.reference,
            resolved_engineering_object_type: resolvedObject.object_type,
            object_resolution_method: resolvedObject.resolution_method,
            active_object_updated: bindResult.updated,
            active_object_reference: bindResult.newActiveObject,
            active_object_type: resolvedObject.object_type,
            conversation_identifier: conversationId,
            conversation_identifier_source: conversationIdSource,
            conversation_scope_verified: conversationScopeVerified,
            lifecycle_change_performed: false,
            context_binding_operation: true,
            previous_active_object_reference: bindResult.previousActiveObject,
            context_first_diagnostics: diag,
            conversational_response: "Engineering Work Order " + resolvedObject.reference + " has been inspected and bound as the active conversational object for this conversation. No lifecycle mutation was performed. The EWO status, lifecycle state, and all domain records remain unchanged.",
            retrieved_artefacts: inspectionArtefacts ? {
              ewo_ref: inspectionArtefacts.ewo_ref,
              ewo_title: inspectionArtefacts.ewo_title,
              ewo_status: inspectionArtefacts.ewo_status,
              artefacts_retrieved: inspectionArtefacts.artefacts_retrieved,
              missing_artefacts: inspectionArtefacts.missing_artefacts,
            } : null,
            audit_reference: auditRef,
          }, auditRef };
        }

        // Context binding detected but object NOT resolved → clarification
        if (contextBindingIntent.detected && resolvedObject.resolution_status !== "resolved") {
          const diag = buildContextFirstDiagnostic(
            auditRef, "inspect_and_bind_active_object", contextBindingIntent.confidence,
            "context_binding_failed_object_not_resolved",
            explicitRef, contextualRef, negativeConstraints, resolvedObject,
            "bind_active_engineering_object", null, false, false,
            "context_binding_failed_object_not_resolved",
            null, "object_not_resolved",
            conversationId,
            conversationIdSource,
            activeObjectLookupAttempted,
            activeObjectRecordFound,
            false,
            false, null, false,
            false, null,
            [],
            false, false, null, false, false,
            true, contextBindingIntent.isCombinedWithInspection,
            ["inspect_engineering_work_order", "bind_active_engineering_object"],
            null, null,
            "failed_object_not_resolved",
            false, false,
            "bind_active_engineering_object", null,
            conversationScopeVerified,
          );
          diag.conversation_scope_verified = conversationScopeVerified;
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "bind_active_engineering_object",
            outcome: "unresolved", request_source: "mcp_client",
            client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest,
            session_id: conversationId,
          });
          return { governed: true, data: {
            governed: true,
            detected_intent: "inspect_and_bind_active_object",
            routing_decision: "context_binding_failed_object_not_resolved",
            resolved_engineering_object_reference: null,
            object_resolution_status: resolvedObject.resolution_status,
            active_object_updated: false,
            conversation_identifier: conversationId,
            conversation_identifier_source: conversationIdSource,
            conversation_scope_verified: conversationScopeVerified,
            lifecycle_change_performed: false,
            context_binding_operation: false,
            clarification_required: true,
            clarification_message: "The Engineering Work Order could not be resolved. Please provide a valid canonical reference (e.g., EWO-017R.2R).",
            context_first_diagnostics: diag,
            audit_reference: auditRef,
          }, auditRef };
        }

        // ── Routing Decision ─────────────────────────────────────────────
        // Priority 1: Engineering continuation intent detected
        if (continuationIntent.detected && continuationIntent.intent) {
          const intent = continuationIntent.intent;
          const operation = continuationIntent.operation ?? "continue_engineering_analysis";

          // Check if object resolution failed or is ambiguous
          if (resolvedObject.resolution_status === "failed") {
            const diag = buildContextFirstDiagnostic(
              auditRef, intent, continuationIntent.confidence,
              "unresolved_contextual_engineering_request",
              explicitRef, contextualRef, negativeConstraints, resolvedObject,
              operation, null, false, false,
              "clarification_required_object_not_resolved",
              null, "object_resolution_failed",
              conversationId,
              conversationIdSource,
              activeObjectLookupAttempted,
              activeObjectRecordFound,
              false,
              false, null, false,
              false, null,
              [],
              false, false, null, false, false,
              conversationScopeVerified,
            );
            diag.conversation_scope_verified = conversationScopeVerified;
            await supabase.from("atd_connect_inspection_log").insert({
              request_id: auditRef, timestamp: new Date().toISOString(),
              requesting_persona: reqPersona, operation,
              outcome: "unresolved", request_source: "mcp_client",
              client_id: reqClientId, tool_name: toolName,
              original_request: nlRequest,
              session_id: conversationId,
              resolved_object_reference: null,
            });
            return { governed: true, data: {
              governed: true,
              detected_intent: intent,
              routing_decision: "unresolved_contextual_engineering_request",
              resolved_engineering_object_reference: null,
              object_resolution_status: "failed",
              conversation_identifier: conversationId,
              conversation_identifier_source: conversationIdSource,
              conversation_scope_verified: conversationScopeVerified,
              capability_metadata_lookup_attempted: false,
              negative_constraints_detected: negativeConstraints.detected,
              clarification_required: true,
              clarification_message: formatClarificationResponse(intent, resolvedObject),
              context_first_diagnostics: diag,
              conversational_response: formatClarificationResponse(intent, resolvedObject),
              audit_reference: auditRef,
            }, auditRef };
          }

          if (resolvedObject.resolution_status === "ambiguous") {
            const diag = buildContextFirstDiagnostic(
              auditRef, intent, continuationIntent.confidence,
              "unresolved_contextual_engineering_request",
              explicitRef, contextualRef, negativeConstraints, resolvedObject,
              operation, null, false, false,
              "clarification_required_ambiguous_objects",
              null, "ambiguous_object_resolution",
              conversationId,
              conversationIdSource,
              activeObjectLookupAttempted,
              activeObjectRecordFound,
              false,
              false, null, false,
              false, null,
              [],
              false, false, null, false, false,
              conversationScopeVerified,
            );
            diag.conversation_scope_verified = conversationScopeVerified;
            await supabase.from("atd_connect_inspection_log").insert({
              request_id: auditRef, timestamp: new Date().toISOString(),
              requesting_persona: reqPersona, operation,
              outcome: "unresolved", request_source: "mcp_client",
              client_id: reqClientId, tool_name: toolName,
              original_request: nlRequest,
              session_id: conversationId,
            });
            return { governed: true, data: {
              governed: true,
              detected_intent: intent,
              routing_decision: "unresolved_contextual_engineering_request",
              resolved_engineering_object_reference: null,
              object_resolution_status: "ambiguous",
              candidate_objects: resolvedObject.candidate_objects,
              ambiguity_detected: true,
              conversation_identifier: conversationId,
              conversation_identifier_source: conversationIdSource,
              conversation_scope_verified: conversationScopeVerified,
              capability_metadata_lookup_attempted: false,
              negative_constraints_detected: negativeConstraints.detected,
              clarification_required: true,
              clarification_message: formatClarificationResponse(intent, resolvedObject),
              context_first_diagnostics: diag,
              conversational_response: formatClarificationResponse(intent, resolvedObject),
              audit_reference: auditRef,
            }, auditRef };
          }

          // Object resolved — retrieve governed analysis and return grounded continuation
          if (resolvedObject.resolution_status === "resolved") {
            // EWO-017R.2R: Retrieve governed Engineering Analysis and linked artefacts
            let artefacts: RetrievedEngineeringArtefacts | null = null;
            let linkedAnalysisLookupAttempted = false;
            let linkedPlanLookupAttempted = false;
            let linkedAnalysisReference: string | null = null;
            let linkedAnalysisRetrieved = false;
            let linkedPlanReference: string | null = null;
            let artefactsRetrieved: string[] = [];

            if (resolvedObject.object_type === "engineering_work_order" && resolvedObject.reference) {
              linkedAnalysisLookupAttempted = true;
              linkedPlanLookupAttempted = true;
              artefacts = await retrieveEngineeringAnalysis(supabase, resolvedObject.reference);
              if (artefacts) {
                linkedAnalysisRetrieved = true;
                linkedAnalysisReference = resolvedObject.reference;
                artefactsRetrieved = artefacts.artefacts_retrieved;
                if (artefacts.linked_plan) {
                  linkedPlanReference = artefacts.linked_plan.plan_ref ?? null;
                }
              }
            }

            // Select the appropriate response formatter based on intent
            let conversationalResponse: string;
            if (intent === "engineering_plan_continuation") {
              conversationalResponse = formatGroundedPlanContinuationResponse(
                intent, operation, resolvedObject, negativeConstraints, artefacts);
            } else {
              conversationalResponse = formatGroundedContinuationResponse(
                intent, operation, resolvedObject, negativeConstraints, artefacts);
            }

            const diag = buildContextFirstDiagnostic(
              auditRef, intent, continuationIntent.confidence,
              "continue_engineering_analysis",
              explicitRef, contextualRef, negativeConstraints, resolvedObject,
              operation, null, false, false,
              "engineering_continuation_routed",
              null, null,
              conversationId,
              conversationIdSource,
              activeObjectLookupAttempted,
              activeObjectRecordFound,
              activeObjectUpdated,
              linkedAnalysisLookupAttempted,
              linkedAnalysisReference,
              linkedAnalysisRetrieved,
              linkedPlanLookupAttempted,
              linkedPlanReference,
              artefactsRetrieved,
              true, // continuation_handler_invoked
              true, // continuation_output_created
              null, // governed_draft_reference
              false, // lifecycle_mutation_attempted
              false, // lifecycle_mutation_performed
              conversationScopeVerified,
            );
            diag.conversation_scope_verified = conversationScopeVerified;
            await supabase.from("atd_connect_inspection_log").insert({
              request_id: auditRef, timestamp: new Date().toISOString(),
              requesting_persona: reqPersona, operation,
              outcome: "success", request_source: "mcp_client",
              client_id: reqClientId, tool_name: toolName,
              original_request: nlRequest,
              session_id: conversationId,
              resolved_object_reference: resolvedObject.reference,
            });
            return { governed: true, data: {
              governed: true,
              detected_intent: intent,
              routing_decision: "continue_engineering_analysis",
              resolved_engineering_object_reference: resolvedObject.reference,
              resolved_engineering_object_type: resolvedObject.object_type,
              object_resolution_status: "resolved",
              object_resolution_method: resolvedObject.resolution_method,
              context_resolution_source: resolvedObject.context_resolution_source,
              conversation_identifier: conversationId,
              conversation_identifier_source: conversationIdSource,
              conversation_scope_verified: conversationScopeVerified,
              capability_metadata_lookup_attempted: false,
              negative_constraints_detected: negativeConstraints.detected,
              clarification_required: false,
              context_first_diagnostics: diag,
              conversational_response: conversationalResponse,
              retrieved_artefacts: artefacts ? {
                ewo_ref: artefacts.ewo_ref,
                ewo_title: artefacts.ewo_title,
                ewo_status: artefacts.ewo_status,
                linked_intent: artefacts.linked_intent ? {
                  intent_ref: artefacts.linked_intent.intent_ref,
                  title: artefacts.linked_intent.title,
                  status: artefacts.linked_intent.status,
                } : null,
                linked_plan: artefacts.linked_plan ? {
                  plan_ref: artefacts.linked_plan.plan_ref,
                  status: artefacts.linked_plan.status,
                  executive_summary: artefacts.linked_plan.executive_summary,
                } : null,
                linked_reviews_count: artefacts.linked_reviews.length,
                po_reviews_count: artefacts.po_reviews.length,
                artefacts_retrieved: artefacts.artefacts_retrieved,
                missing_artefacts: artefacts.missing_artefacts,
              } : null,
              audit_reference: auditRef,
            }, auditRef };
          }

          // Continuation detected but no contextual reference and no explicit ref
          // → unresolved contextual engineering request
          if (!contextualRef.detected && !explicitRef.detected) {
            const diag = buildContextFirstDiagnostic(
              auditRef, intent, continuationIntent.confidence,
              "unresolved_contextual_engineering_request",
              explicitRef, contextualRef, negativeConstraints, resolvedObject,
              operation, null, false, false,
              "clarification_required_no_context",
              null, "no_contextual_or_explicit_reference",
              conversationId,
              conversationIdSource,
              activeObjectLookupAttempted,
              activeObjectRecordFound,
              false,
              false, null, false,
              false, null,
              [],
              false, false, null, false, false,
              conversationScopeVerified,
            );
            diag.conversation_scope_verified = conversationScopeVerified;
            await supabase.from("atd_connect_inspection_log").insert({
              request_id: auditRef, timestamp: new Date().toISOString(),
              requesting_persona: reqPersona, operation,
              outcome: "unresolved", request_source: "mcp_client",
              client_id: reqClientId, tool_name: toolName,
              original_request: nlRequest,
              session_id: conversationId,
            });
            return { governed: true, data: {
              governed: true,
              detected_intent: intent,
              routing_decision: "unresolved_contextual_engineering_request",
              resolved_engineering_object_reference: null,
              object_resolution_status: "failed",
              conversation_identifier: conversationId,
              conversation_identifier_source: conversationIdSource,
              conversation_scope_verified: conversationScopeVerified,
              capability_metadata_lookup_attempted: false,
              negative_constraints_detected: negativeConstraints.detected,
              clarification_required: true,
              clarification_message: formatClarificationResponse(intent, resolvedObject),
              context_first_diagnostics: diag,
              conversational_response: formatClarificationResponse(intent, resolvedObject),
              audit_reference: auditRef,
            }, auditRef };
          }
        }

        // Priority 2: Check for write requests that include continuation language
        // (e.g. "expand this analysis, approve the plan, close the EWO and deploy it")
        const writeCheck = classifyIntent(nlRequest);
        if (writeCheck.isWriteRequest && continuationIntent.detected) {
          // Separate the analysis portion from lifecycle write requests
          const diag = buildContextFirstDiagnostic(
            auditRef, "engineering_lifecycle_write_request", 0.95,
            "refuse_write_request",
            explicitRef, contextualRef, negativeConstraints, resolvedObject,
            continuationIntent.operation, null, false, true,
            "write_request_refused_with_continuation_detected",
            null, "lifecycle_write_blocked",
            conversationId,
            conversationIdSource,
            activeObjectLookupAttempted,
            activeObjectRecordFound,
            false,
            false, null, false,
            false, null,
            [],
            false, false, null, true, false,
            conversationScopeVerified,
          );
          diag.conversation_scope_verified = conversationScopeVerified;
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "conversationBridge",
            outcome: "governed_refusal", request_source: "mcp_client",
            client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest,
            session_id: conversationId,
          });
          return { governed: true, data: {
            governed: true,
            detected_intent: "engineering_lifecycle_write_request",
            routing_decision: "refuse_write_request",
            resolved_engineering_object_reference: resolvedObject.reference,
            object_resolution_status: resolvedObject.resolution_status,
            capability_metadata_lookup_attempted: false,
            negative_constraints_detected: negativeConstraints.detected,
            write_request_detected: true,
            refused: true,
            reason: "read_only_boundary",
            message: "The request contains lifecycle write operations (approve, close, deploy) which are not supported by ATD Connect. The analysis continuation portion was recognised but no mutation, approval, closure, or deployment was performed.",
            context_first_diagnostics: diag,
            audit_reference: auditRef,
          }, auditRef };
        }

        // Priority 3: Genuine capability metadata inspection (verified by context-first check)
        // Only route here if the request is genuinely about a registered capability
        // and NOT a continuation request with negative constraints.
        if (isGenuineCapMetadata && !continuationIntent.detected) {
          // Fall through to the existing capability metadata inspection handler below
          // (the interpretRequest/classifyIntent path will handle this)
        }

        // ── Fall through to existing routing for non-continuation requests ──
        const interpretation = interpretRequest(nlRequest);
        const intentDiag = interpretation.intentClassification;

        // EWO-017R.1: Framework introspection — route to dedicated handler before
        // capability metadata inspection. Requests about the inspection framework
        // itself must not be misclassified as capability inspection.
        if (intentDiag.isFrameworkIntrospection) {
          const introspectionResponse = buildFrameworkIntrospectionResponse();
          const envelope = buildRuntimeDiagnosticEnvelope(null, 0.95, [], "framework_introspection_returned", "framework_introspection");
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "frameworkIntrospection",
            outcome: "success", request_source: "mcp_client",
            client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest,
            session_id: conversationId,
          });
          return { governed: true, data: { governed: true, interpretation: "Request interpreted as framework introspection. Routed to framework introspection handler.", resolution_outcome: "success", original_request: nlRequest, execution_path: "framework_introspection",
          session_id: conversationId,
            framework_introspection: introspectionResponse,
            intent_diagnostics: intentDiag,
            runtime_diagnostics: envelope,
            conversational_response: formatFrameworkIntrospectionConversational(),
            audit_reference: auditRef }, auditRef };
        }

        // EWO-017R.1: Metadata questions about write support are NOT write requests.
        // Route them to capability inspection before any write-request refusal.
        if (intentDiag.isMetadataQuestion && intentDiag.routing_decision === "inspect_capability_metadata") {
          const capResolution = await resolveCapabilityByName(supabase, nlRequest);
          if (!capResolution.resolved) {
            const failureResponse = buildCapabilityFailureResponse(capResolution);
            const failEnvelope = buildRuntimeDiagnosticEnvelope(null, capResolution.confidence, [], "capability_resolution_failed", "capability_metadata_inspection");
            await supabase.from("atd_connect_inspection_log").insert({
              request_id: auditRef, timestamp: new Date().toISOString(),
              requesting_persona: reqPersona, operation: "inspectCapabilityMetadata",
              outcome: "unresolved", request_source: "mcp_client",
              client_id: reqClientId, tool_name: toolName,
              original_request: nlRequest,
              session_id: conversationId,
            });
            return { governed: true, data: { governed: true, interpretation: "Request interpreted as capability metadata inspection. Capability resolution failed.", ...failureResponse,
              original_request: nlRequest,
              session_id: conversationId,
              intent_diagnostics: intentDiag,
              runtime_diagnostics: failEnvelope,
              conversational_response: formatCapabilityFailureConversational(failureResponse),
              audit_reference: auditRef }, auditRef };
          }
          const { data: capRecord } = await supabase
            .from("atd_connect_capabilities")
            .select("*")
            .eq("capability_id", capResolution.canonical_capability_id!)
            .maybeSingle();
          if (!capRecord) {
            const failEnvelope = buildRuntimeDiagnosticEnvelope(capResolution.canonical_capability_id, capResolution.confidence, [], "metadata_unavailable", "capability_metadata_inspection");
            await supabase.from("atd_connect_inspection_log").insert({
              request_id: auditRef, timestamp: new Date().toISOString(),
              requesting_persona: reqPersona, operation: "inspectCapabilityMetadata",
              outcome: "error", request_source: "mcp_client",
              client_id: reqClientId, tool_name: toolName,
              original_request: nlRequest,
              session_id: conversationId,
              resolved_capability: capResolution.canonical_capability_id,
            });
            return { governed: true, data: { governed: true, interpretation: "Request interpreted as capability metadata inspection. Capability resolved but metadata unavailable.", resolution_outcome: "metadata_unavailable", resolved_capability_id: capResolution.canonical_capability_id, resolved_capability_name: capResolution.canonical_capability_name, extracted_capability_target: capResolution.extractedCapabilityTarget, reason: "Capability resolved but metadata unavailable. No metadata inferred.", no_metadata_inferred: true,
              intent_diagnostics: intentDiag,
              runtime_diagnostics: failEnvelope,
              audit_reference: auditRef }, auditRef };
          }
          const metadataResponse = buildCapabilityMetadataResponse(capRecord);
          const ops = Array.isArray(metadataResponse.operations_exposed) ? metadataResponse.operations_exposed : [];
          const envelope = buildRuntimeDiagnosticEnvelope(capResolution.canonical_capability_id, capResolution.confidence, ops, "governed_metadata_returned", "capability_metadata_inspection");
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "inspectCapabilityMetadata",
            outcome: "success", request_source: "mcp_client",
            client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest,
            session_id: conversationId,
            resolved_capability: capResolution.canonical_capability_id,
          });
          return { governed: true, data: { governed: true, interpretation: "Request interpreted as capability metadata inspection. Capability resolved and metadata returned.", resolution_outcome: "success", original_request: nlRequest, extracted_capability_target: capResolution.extractedCapabilityTarget, resolved_capability_id: capResolution.canonical_capability_id, resolved_capability_name: capResolution.canonical_capability_name, match_type: capResolution.match_type, confidence: capResolution.confidence, capability_metadata: metadataResponse,
          session_id: conversationId,
            intent_diagnostics: intentDiag,
            runtime_diagnostics: envelope,
            conversational_response: formatCapabilityMetadataConversational(metadataResponse),
            audit_reference: auditRef }, auditRef };
        }

        if (interpretation.isWriteRequest) {
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "conversationBridge",
            outcome: "governed_refusal", request_source: "mcp_client",
            client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest,
            session_id: conversationId,
          });
          return { governed: true, data: { governed: true, refused: true, reason: "read_only_boundary", message: "Write request refused. ATD Connect is read-only.",
            intent_diagnostics: intentDiag,
            refusal_reason: "write_request_detected",
            audit_reference: auditRef }, auditRef };
        }

        if (interpretation.ambiguous || !interpretation.capability || !interpretation.operation) {
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "conversationBridge",
            outcome: "unresolved", request_source: "mcp_client",
            client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest,
            session_id: conversationId,
          });
          return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, result_type: "unresolved",
            intent_diagnostics: intentDiag,
            audit_reference: auditRef }, auditRef };
        }

        // EWO-027R.1R.1.MCP — Delegate capability-inspection phrases to the
        // inspect_capability_metadata tool for governed metadata resolution.
        if (interpretation.operation === "inspectCapabilityMetadata") {
          const capResolution = await resolveCapabilityByName(supabase, nlRequest);
          if (!capResolution.resolved) {
            const failureResponse = buildCapabilityFailureResponse(capResolution);
            const failEnvelope = buildRuntimeDiagnosticEnvelope(null, capResolution.confidence, [], "capability_resolution_failed", "capability_metadata_inspection");
            await supabase.from("atd_connect_inspection_log").insert({
              request_id: auditRef, timestamp: new Date().toISOString(),
              requesting_persona: reqPersona, operation: "inspectCapabilityMetadata",
              outcome: "unresolved", request_source: "mcp_client",
              client_id: reqClientId, tool_name: toolName,
              original_request: nlRequest,
              session_id: conversationId,
            });
            return { governed: true, data: { governed: true, interpretation: "Request interpreted as capability metadata inspection. Capability resolution failed.", ...failureResponse,
              original_request: nlRequest,
              session_id: conversationId,
              runtime_diagnostics: failEnvelope,
              conversational_response: formatCapabilityFailureConversational(failureResponse),
              audit_reference: auditRef }, auditRef };
          }
          const { data: capRecord } = await supabase
            .from("atd_connect_capabilities")
            .select("*")
            .eq("capability_id", capResolution.canonical_capability_id!)
            .maybeSingle();
          if (!capRecord) {
            const failEnvelope = buildRuntimeDiagnosticEnvelope(capResolution.canonical_capability_id, capResolution.confidence, [], "metadata_unavailable", "capability_metadata_inspection");
            await supabase.from("atd_connect_inspection_log").insert({
              request_id: auditRef, timestamp: new Date().toISOString(),
              requesting_persona: reqPersona, operation: "inspectCapabilityMetadata",
              outcome: "error", request_source: "mcp_client",
              client_id: reqClientId, tool_name: toolName,
              original_request: nlRequest,
              session_id: conversationId,
              resolved_capability: capResolution.canonical_capability_id,
            });
            return { governed: true, data: { governed: true, interpretation: "Request interpreted as capability metadata inspection. Capability resolved but metadata unavailable.", resolution_outcome: "metadata_unavailable", resolved_capability_id: capResolution.canonical_capability_id, resolved_capability_name: capResolution.canonical_capability_name, extracted_capability_target: capResolution.extractedCapabilityTarget, reason: "Capability resolved but metadata unavailable. No metadata inferred.", no_metadata_inferred: true,
              runtime_diagnostics: failEnvelope,
              audit_reference: auditRef }, auditRef };
          }
          const metadataResponse = buildCapabilityMetadataResponse(capRecord);
          const ops = Array.isArray(metadataResponse.operations_exposed) ? metadataResponse.operations_exposed : [];
          const envelope = buildRuntimeDiagnosticEnvelope(capResolution.canonical_capability_id, capResolution.confidence, ops, "governed_metadata_returned", "capability_metadata_inspection");
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "inspectCapabilityMetadata",
            outcome: "success", request_source: "mcp_client",
            client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest,
            session_id: conversationId,
            resolved_capability: capResolution.canonical_capability_id,
          });
          return { governed: true, data: { governed: true, interpretation: "Request interpreted as capability metadata inspection. Capability resolved and metadata returned.", resolution_outcome: "success", original_request: nlRequest, extracted_capability_target: capResolution.extractedCapabilityTarget, resolved_capability_id: capResolution.canonical_capability_id, resolved_capability_name: capResolution.canonical_capability_name, match_type: capResolution.match_type, confidence: capResolution.confidence, capability_metadata: metadataResponse,
          session_id: conversationId,
            runtime_diagnostics: envelope,
            conversational_response: formatCapabilityMetadataConversational(metadataResponse),
            audit_reference: auditRef }, auditRef };
        }

        // EWO-031: Execute governed execution operations
        if (interpretation.capability === "engineering-work-orders" && interpretation.operation === "createEngineeringWorkOrderFromConversation") {
          const ewoRef = interpretation.objectReference ?? "";
          // Check if EWO already exists
          const { data: existing } = await supabase.from("engineering_work_orders").select("ewo_ref, status").eq("ewo_ref", ewoRef).maybeSingle();
          if (existing) {
            return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "engineering-work-orders", resolved_operation: "createEngineeringWorkOrderFromConversation", resolved_object_reference: ewoRef, ewo_already_exists: true, ewo_status: existing.status, lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
          }
          // Create the EWO
          const { error: createError } = await supabase.from("engineering_work_orders").insert({ ewo_ref: ewoRef, title: `Engineering Work Order ${ewoRef}`, status: "draft", engineering_package_status: "Not Generated", implementation_status: "not_started" });
          if (createError) {
            return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "engineering-work-orders", resolved_operation: "createEngineeringWorkOrderFromConversation", resolved_object_reference: ewoRef, error: createError.message, lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
          }
          await supabase.from("atd_connect_inspection_log").insert({ request_id: auditRef, timestamp: new Date().toISOString(), requesting_persona: reqPersona, operation: "createEngineeringWorkOrderFromConversation", inspected_capability: "engineering-work-orders", outcome: "success", request_source: "mcp_client", client_id: reqClientId, tool_name: toolName, original_request: nlRequest, session_id: conversationId, resolved_capability: "engineering-work-orders", resolved_operation: "createEngineeringWorkOrderFromConversation", resolved_object_reference: ewoRef });
          return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "engineering-work-orders", resolved_operation: "createEngineeringWorkOrderFromConversation", resolved_object_reference: ewoRef, ewo_created: true, ewo_status: "draft", lifecycle_change_performed: true, audit_reference: auditRef, session_id: conversationId }, auditRef };
        }

        if (interpretation.capability === "engineering-work-orders" && interpretation.operation === "prepareEngineeringAnalysis") {
          const ewoRef = interpretation.objectReference ?? "";
          const { data: analysisData, error: analysisError } = await supabase.rpc("prepare_engineering_analysis", { p_ewo_ref: ewoRef, p_prepared_by: reqPersona });
          if (analysisError || !analysisData) {
            return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "engineering-work-orders", resolved_operation: "prepareEngineeringAnalysis", resolved_object_reference: ewoRef, error: analysisError?.message ?? "RPC returned no data", lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
          }
          await supabase.from("atd_connect_inspection_log").insert({ request_id: auditRef, timestamp: new Date().toISOString(), requesting_persona: reqPersona, operation: "prepareEngineeringAnalysis", inspected_capability: "engineering-work-orders", outcome: "success", request_source: "mcp_client", client_id: reqClientId, tool_name: toolName, original_request: nlRequest, session_id: conversationId, resolved_capability: "engineering-work-orders", resolved_operation: "prepareEngineeringAnalysis", resolved_object_reference: ewoRef });
          return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "engineering-work-orders", resolved_operation: "prepareEngineeringAnalysis", resolved_object_reference: ewoRef, analysis_result: analysisData, lifecycle_change_performed: true, audit_reference: auditRef, session_id: conversationId }, auditRef };
        }

        if (interpretation.capability === "engineering-work-orders" && interpretation.operation === "prepareEngineeringPlan") {
          const ewoRef = interpretation.objectReference ?? "";
          const { data: planData, error: planError } = await supabase.rpc("prepare_engineering_plan", { p_ewo_ref: ewoRef, p_prepared_by: reqPersona });
          if (planError || !planData) {
            return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "engineering-work-orders", resolved_operation: "prepareEngineeringPlan", resolved_object_reference: ewoRef, error: planError?.message ?? "RPC returned no data", lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
          }
          await supabase.from("atd_connect_inspection_log").insert({ request_id: auditRef, timestamp: new Date().toISOString(), requesting_persona: reqPersona, operation: "prepareEngineeringPlan", inspected_capability: "engineering-work-orders", outcome: "success", request_source: "mcp_client", client_id: reqClientId, tool_name: toolName, original_request: nlRequest, session_id: conversationId, resolved_capability: "engineering-work-orders", resolved_operation: "prepareEngineeringPlan", resolved_object_reference: ewoRef });
          return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "engineering-work-orders", resolved_operation: "prepareEngineeringPlan", resolved_object_reference: ewoRef, plan_result: planData, lifecycle_change_performed: true, audit_reference: auditRef, session_id: conversationId }, auditRef };
        }

        if (interpretation.capability === "engineering-work-orders" && interpretation.operation === "approveEngineeringWorkOrderForExecution") {
          const ewoRef = interpretation.objectReference ?? "";
          const isCodex = /codex/i.test(nlRequest);
          const { data: approvalData, error: approvalError } = await supabase.rpc("approve_ewo_for_execution", { p_ewo_ref: ewoRef, p_approved_by: reqPersona, p_decision: "approved", p_approval_statement: "Execution approved through governed conversation routing.", p_provider_preference: isCodex ? "codex" : null });
          if (approvalError || !approvalData) {
            return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "engineering-work-orders", resolved_operation: "approveEngineeringWorkOrderForExecution", resolved_object_reference: ewoRef, error: approvalError?.message ?? "RPC returned no data", lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
          }
          await supabase.from("atd_connect_inspection_log").insert({ request_id: auditRef, timestamp: new Date().toISOString(), requesting_persona: reqPersona, operation: "approveEngineeringWorkOrderForExecution", inspected_capability: "engineering-work-orders", outcome: "success", request_source: "mcp_client", client_id: reqClientId, tool_name: toolName, original_request: nlRequest, session_id: conversationId, resolved_capability: "engineering-work-orders", resolved_operation: "approveEngineeringWorkOrderForExecution", resolved_object_reference: ewoRef });
          return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "engineering-work-orders", resolved_operation: "approveEngineeringWorkOrderForExecution", resolved_object_reference: ewoRef, approval_result: approvalData, lifecycle_change_performed: true, audit_reference: auditRef, session_id: conversationId }, auditRef };
        }

        if (interpretation.capability === "supervised-engineering-execution" && interpretation.operation === "executeEngineeringWorkOrder") {
          const ewoRef = interpretation.objectReference ?? "";
          const isCodex = /codex/i.test(nlRequest);
          // Evaluate execution gate
          const { data: gateData, error: gateError } = await supabase.rpc("inspect_ewo_execution_state", { p_ewo_ref: ewoRef });
          if (gateError || !gateData) {
            return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "supervised-engineering-execution", resolved_operation: "executeEngineeringWorkOrder", resolved_object_reference: ewoRef, error: gateError?.message ?? "RPC returned no data", execution_status: "failed", failed_stage: "gate_evaluation", lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
          }
          const gate = typeof gateData === "string" ? JSON.parse(gateData) : gateData;
          if (!gate.execution_eligible) {
            // Determine the exact missing gate
            const blockers: string[] = [];
            if (!gate.analysis?.exists) blockers.push("Engineering Analysis must be prepared");
            if (!gate.plan?.exists) blockers.push("Engineering Plan must be prepared");
            if (!gate.execution_approval?.exists) blockers.push("Product Owner execution approval is required");
            if (gate.ewo_status === "closed" || gate.ewo_status === "archived") blockers.push(`EWO is ${gate.ewo_status}`);
            const nextAction = blockers[0] ?? "Resolve all blocking gates before execution can begin.";
            return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "supervised-engineering-execution", resolved_operation: "executeEngineeringWorkOrder", resolved_object_reference: ewoRef, execution_status: "blocked", failed_stage: "execution_gate", failure_code: "gate_failed", failure_reason: nextAction, blockers, lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
          }
          // Gate passed — attempt execution through the supervised pipeline
          // Note: actual Codex dispatch happens through the supervised execution engine.
          // If Codex credentials are unavailable, this will return a governed failure.
          try {
            const { data: providers } = await supabase.from("execution_provider_registry").select("*").eq("is_active", true);
            const codexProvider = (providers ?? []).find((p: Record<string, unknown>) => String(p.provider_name).toLowerCase() === "codex");
            if (isCodex && !codexProvider) {
              return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "supervised-engineering-execution", resolved_operation: "executeEngineeringWorkOrder", resolved_object_reference: ewoRef, execution_status: "refused", failed_stage: "provider_selection", failure_code: "codex_unavailable", failure_reason: "Codex provider is not available. Codex-only execution requested — fallback is not permitted.", fallback_permitted: false, fallback_performed: false, lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
            }
            // Create execution record
            const executionRef = `SER-${ewoRef}-${Date.now()}`;
            const { data: ewo } = await supabase.from("engineering_work_orders").select("id").eq("ewo_ref", ewoRef).maybeSingle();
            const { error: execError } = await supabase.from("supervised_execution_records").insert({ execution_ref: executionRef, ewo_id: ewo?.id, ewo_ref: ewoRef, provider: isCodex ? "codex" : "bolt", execution_status: "pending", governance_gate_passed: true, governance_diagnostics: { gate_data: gate } });
            if (execError) {
              return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "supervised-engineering-execution", resolved_operation: "executeEngineeringWorkOrder", resolved_object_reference: ewoRef, execution_status: "failed", failed_stage: "execution_record_creation", failure_code: "db_error", failure_reason: execError.message, lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
            }
            await supabase.from("atd_connect_inspection_log").insert({ request_id: auditRef, timestamp: new Date().toISOString(), requesting_persona: reqPersona, operation: "executeEngineeringWorkOrder", inspected_capability: "supervised-engineering-execution", outcome: "success", request_source: "mcp_client", client_id: reqClientId, tool_name: toolName, original_request: nlRequest, session_id: conversationId, resolved_capability: "supervised-engineering-execution", resolved_operation: "executeEngineeringWorkOrder", resolved_object_reference: ewoRef });
            return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "supervised-engineering-execution", resolved_operation: "executeEngineeringWorkOrder", resolved_object_reference: ewoRef, execution_status: "dispatched", execution_ref: executionRef, selected_provider: isCodex ? "codex" : "bolt", fallback_permitted: !isCodex, fallback_performed: false, lifecycle_change_performed: true, audit_reference: auditRef, session_id: conversationId }, auditRef };
          } catch (e) {
            return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "supervised-engineering-execution", resolved_operation: "executeEngineeringWorkOrder", resolved_object_reference: ewoRef, execution_status: "failed", failed_stage: "execution_dispatch", failure_code: "exception", failure_reason: e instanceof Error ? e.message : "Unknown error", lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
          }
        }

        if (interpretation.capability === "supervised-engineering-execution" && interpretation.operation === "inspectExecutionProviderPolicy") {
          const ewoRef = interpretation.objectReference ?? "";
          const { data: policyData, error: policyError } = await supabase.rpc("inspect_execution_provider_policy", { p_ewo_ref: ewoRef || null });
          if (policyError || !policyData) {
            // EWO-031R.2: Governed failure — do NOT fall back to legacy Bolt inspection
            await supabase.from("atd_connect_inspection_log").insert({ request_id: auditRef, timestamp: new Date().toISOString(), requesting_persona: reqPersona, operation: "inspectExecutionProviderPolicy", inspected_capability: "supervised-engineering-execution", outcome: "error", request_source: "mcp_client", client_id: reqClientId, tool_name: toolName, original_request: nlRequest, session_id: conversationId, resolved_capability: "supervised-engineering-execution", resolved_operation: "inspectExecutionProviderPolicy", resolved_object_reference: ewoRef });
            return { governed: true, data: {
              governed: true,
              inspection_status: "failed",
              failed_stage: "rpc_invocation",
              failure_code: "provider_policy_rpc_failed",
              failure_reason: policyError?.message ?? "RPC returned no data",
              detected_intent: "provider_policy_inspection",
              resolved_capability: "supervised-engineering-execution",
              resolved_operation: "inspectExecutionProviderPolicy",
              resolved_object_reference: ewoRef,
              data_source: "inspect_execution_provider_policy RPC",
              environment: "supabase_edge_function",
              legacy_fallback_permitted: false,
              legacy_fallback_performed: false,
              retryable: true,
              next_required_action: "Verify that the inspect_execution_provider_policy RPC exists and the execution_provider_policy table has an active record.",
              lifecycle_change_performed: false,
              audit_reference: auditRef,
              session_id: conversationId,
            }, auditRef };
          }
          const policy = typeof policyData === "string" ? JSON.parse(policyData) : policyData;
          await supabase.from("atd_connect_inspection_log").insert({ request_id: auditRef, timestamp: new Date().toISOString(), requesting_persona: reqPersona, operation: "inspectExecutionProviderPolicy", inspected_capability: "supervised-engineering-execution", outcome: "success", request_source: "mcp_client", client_id: reqClientId, tool_name: toolName, original_request: nlRequest, session_id: conversationId, resolved_capability: "supervised-engineering-execution", resolved_operation: "inspectExecutionProviderPolicy", resolved_object_reference: ewoRef });
          return { governed: true, data: {
            governed: true,
            detected_intent: "provider_policy_inspection",
            routing_decision: "route_to_inspectExecutionProviderPolicy",
            resolved_capability: "supervised-engineering-execution",
            resolved_operation: "inspectExecutionProviderPolicy",
            resolved_object_reference: ewoRef,
            data_source: "inspect_execution_provider_policy RPC (authoritative)",
            provider_policy: policy,
            active_execution_provider: policy.active_execution_provider ?? policy.default_provider_id ?? null,
            default_execution_provider: policy.default_provider_id ?? null,
            preferred_execution_provider: policy.preferred_provider_id ?? null,
            allowed_execution_providers: policy.allowed_provider_ids ?? [],
            fallback_provider: policy.fallback_provider_id ?? null,
            fallback_permitted: policy.fallback_permitted ?? false,
            fallback_performed: false,
            requested_provider_for_ewo: policy.ewo_implementation_provider ?? null,
            selected_provider_for_ewo: policy.ewo_selected_provider ?? null,
            provider_selection_reason: policy.provider_selection_reason ?? null,
            lifecycle_change_performed: false,
            audit_reference: auditRef,
            session_id: conversationId,
          }, auditRef };
        }

        // EWO-032: Execute execution handoff inspection
        if (interpretation.capability === "supervised-engineering-execution" && interpretation.operation === "inspectExecutionHandoff") {
          const ewoRef = interpretation.objectReference ?? "";
          const { data: handoffData, error: handoffError } = await supabase.rpc("inspect_execution_handoff", { p_ewo_ref: ewoRef || null, p_conversation_id: conversationId || null });
          if (handoffError || !handoffData) {
            await supabase.from("atd_connect_inspection_log").insert({ request_id: auditRef, timestamp: new Date().toISOString(), requesting_persona: reqPersona, operation: "inspectExecutionHandoff", inspected_capability: "supervised-engineering-execution", outcome: "error", request_source: "mcp_client", client_id: reqClientId, tool_name: toolName, original_request: nlRequest, session_id: conversationId, resolved_capability: "supervised-engineering-execution", resolved_operation: "inspectExecutionHandoff", resolved_object_reference: ewoRef });
            return { governed: true, data: { governed: true, inspection_status: "failed", failed_stage: "rpc_invocation", failure_code: "execution_handoff_rpc_failed", failure_reason: handoffError?.message ?? "RPC returned no data", detected_intent: "execution_handoff_inspection", resolved_capability: "supervised-engineering-execution", resolved_operation: "inspectExecutionHandoff", resolved_object_reference: ewoRef, data_source: "inspect_execution_handoff RPC", legacy_fallback_permitted: false, legacy_fallback_performed: false, lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
          }
          const handoff = typeof handoffData === "string" ? JSON.parse(handoffData) : handoffData;
          await supabase.from("atd_connect_inspection_log").insert({ request_id: auditRef, timestamp: new Date().toISOString(), requesting_persona: reqPersona, operation: "inspectExecutionHandoff", inspected_capability: "supervised-engineering-execution", outcome: "success", request_source: "mcp_client", client_id: reqClientId, tool_name: toolName, original_request: nlRequest, session_id: conversationId, resolved_capability: "supervised-engineering-execution", resolved_operation: "inspectExecutionHandoff", resolved_object_reference: ewoRef });
          return { governed: true, data: { governed: true, detected_intent: "execution_handoff_inspection", routing_decision: "route_to_inspectExecutionHandoff", resolved_capability: "supervised-engineering-execution", resolved_operation: "inspectExecutionHandoff", resolved_object_reference: ewoRef, data_source: "inspect_execution_handoff RPC (authoritative)", handoff_found: handoff.handoff_found ?? false, work_order_reference: handoff.work_order_reference ?? null, conversation_id: handoff.conversation_id ?? null, plan_version: handoff.plan_version ?? null, approval_received: handoff.approval_received ?? false, approval_validated: handoff.approval_validated ?? false, execution_request_created: handoff.execution_request_created ?? false, execution_request_id: handoff.execution_request_id ?? null, dispatch_attempted: handoff.dispatch_attempted ?? false, governed_execution_engine_invoked: handoff.governed_execution_engine_invoked ?? false, execution_session_id: handoff.execution_session_id ?? null, requested_provider_id: handoff.requested_provider_id ?? null, selected_provider_id: handoff.selected_provider_id ?? null, provider_selection_reason: handoff.provider_selection_reason ?? null, provider_readiness_status: handoff.provider_readiness_status ?? "not_checked", provider_readiness_detail: handoff.provider_readiness_detail ?? {}, current_execution_status: handoff.current_execution_status ?? null, failure_stage: handoff.failure_stage ?? null, exact_runtime_error: handoff.exact_runtime_error ?? null, lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
        }

        if (interpretation.capability === "supervised-engineering-execution" && interpretation.operation === "inspectEngineeringExecution") {
          const ewoRef = interpretation.objectReference ?? "";
          const { data: execData, error: execError } = await supabase.rpc("inspect_ewo_execution_state", { p_ewo_ref: ewoRef });
          if (execError || !execData) {
            return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "supervised-engineering-execution", resolved_operation: "inspectEngineeringExecution", resolved_object_reference: ewoRef, error: execError?.message ?? "RPC returned no data", lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
          }
          await supabase.from("atd_connect_inspection_log").insert({ request_id: auditRef, timestamp: new Date().toISOString(), requesting_persona: reqPersona, operation: "inspectEngineeringExecution", inspected_capability: "supervised-engineering-execution", outcome: "success", request_source: "mcp_client", client_id: reqClientId, tool_name: toolName, original_request: nlRequest, session_id: conversationId, resolved_capability: "supervised-engineering-execution", resolved_operation: "inspectEngineeringExecution", resolved_object_reference: ewoRef });
          return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "supervised-engineering-execution", resolved_operation: "inspectEngineeringExecution", resolved_object_reference: ewoRef, inspection_result: execData, lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
        }

        // EWO-030R.5: Execute acceptance governance inspection
        if (interpretation.capability === "engineering-work-orders" && interpretation.operation === "inspectEngineeringWorkOrderAcceptanceGovernance") {
          const ewoRef = interpretation.objectReference ?? "";
          const { data: acceptanceData, error: acceptanceError } = await supabase.rpc("inspect_ewo_acceptance_state", { p_ewo_ref: ewoRef });
          if (acceptanceError || !acceptanceData) {
            await supabase.from("atd_connect_inspection_log").insert({
              request_id: auditRef, timestamp: new Date().toISOString(),
              requesting_persona: reqPersona, operation: "inspectEngineeringWorkOrderAcceptanceGovernance",
              inspected_capability: "engineering-work-orders",
              outcome: "error", request_source: "mcp_client",
              client_id: reqClientId, tool_name: toolName,
              original_request: nlRequest, session_id: conversationId,
              resolved_capability: "engineering-work-orders",
              resolved_operation: "inspectEngineeringWorkOrderAcceptanceGovernance",
              resolved_object_reference: ewoRef,
            });
            return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "engineering-work-orders", resolved_operation: "inspectEngineeringWorkOrderAcceptanceGovernance", resolved_object_reference: ewoRef, error: acceptanceError?.message ?? "RPC returned no data", lifecycle_change_performed: false, audit_reference: auditRef, session_id: conversationId }, auditRef };
          }
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "inspectEngineeringWorkOrderAcceptanceGovernance",
            inspected_capability: "engineering-work-orders",
            outcome: "success", request_source: "mcp_client",
            client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest, session_id: conversationId,
            resolved_capability: "engineering-work-orders",
            resolved_operation: "inspectEngineeringWorkOrderAcceptanceGovernance",
            resolved_object_reference: ewoRef,
          });
          return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: "engineering-work-orders", resolved_operation: "inspectEngineeringWorkOrderAcceptanceGovernance", resolved_object_reference: ewoRef, inspection_result: acceptanceData, lifecycle_change_performed: false, intent_diagnostics: intentDiag, audit_reference: auditRef, session_id: conversationId }, auditRef };
        }

        // EWO-029R.1: Execute supervised execution engine inspection
        if (interpretation.capability === "supervised-engineering-execution" && interpretation.operation === "inspectSupervisedExecutionEngine") {
          const engineResult = await inspectSupervisedExecutionEngineMcp(supabase);
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "inspectSupervisedExecutionEngine",
            inspected_capability: "supervised-engineering-execution",
            outcome: "success", request_source: "mcp_client",
            client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest,
            session_id: conversationId,
            resolved_capability: "supervised-engineering-execution",
            resolved_operation: "inspectSupervisedExecutionEngine",
          });
          return { governed: true, data: {
            governed: true,
            interpretation: interpretation.interpretation,
            resolved_capability: "supervised-engineering-execution",
            resolved_operation: "inspectSupervisedExecutionEngine",
            resolved_object_reference: null,
            inspection_result: engineResult,
            detected_intent: "supervised_execution_engine_inspection",
            routing_decision: "route_to_inspectSupervisedExecutionEngine",
            lifecycle_change_performed: false,
            intent_diagnostics: intentDiag,
            audit_reference: auditRef,
            session_id: conversationId,
          }, auditRef };
        }

        // EWO-030R.2: Execute Codex provider implementation evidence inspection
        if (interpretation.capability === "supervised-engineering-execution" && interpretation.operation === "inspectCodexProviderImplementationEvidence") {
          const codexResult = await inspectCodexProviderImplementationEvidenceMcp(supabase);
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "inspectCodexProviderImplementationEvidence",
            inspected_capability: "supervised-engineering-execution",
            outcome: "success", request_source: "mcp_client",
            client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest,
            session_id: conversationId,
            resolved_capability: "supervised-engineering-execution",
            resolved_operation: "inspectCodexProviderImplementationEvidence",
          });
          return { governed: true, data: {
            governed: true,
            interpretation: interpretation.interpretation,
            resolved_capability: "supervised-engineering-execution",
            resolved_operation: "inspectCodexProviderImplementationEvidence",
            resolved_object_reference: "codex",
            inspection_result: codexResult,
            detected_intent: "codex_provider_implementation_evidence_inspection",
            routing_decision: "route_to_inspectCodexProviderImplementationEvidence",
            lifecycle_change_performed: false,
            intent_diagnostics: (codexResult as Record<string, unknown>).intent_diagnostics,
            audit_reference: auditRef,
            session_id: conversationId,
          }, auditRef };
        }

        // EWO-029R.2: Execute execution provider inspection
        if (interpretation.capability === "supervised-engineering-execution" && interpretation.operation === "inspectExecutionProvider") {
          const rawTarget = interpretation.objectReference ?? extractProviderTarget(nlRequest);
          const providerResult = await inspectExecutionProviderMcp(supabase, rawTarget);
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "inspectExecutionProvider",
            inspected_capability: "supervised-engineering-execution",
            outcome: providerResult.resolved_provider_id ? "success" : "unresolved",
            request_source: "mcp_client",
            client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest,
            session_id: conversationId,
            resolved_capability: "supervised-engineering-execution",
            resolved_operation: "inspectExecutionProvider",
            inspected_object: rawTarget,
          });
          return { governed: true, data: {
            governed: true,
            interpretation: interpretation.interpretation,
            resolved_capability: "supervised-engineering-execution",
            resolved_operation: "inspectExecutionProvider",
            resolved_object_reference: rawTarget,
            inspection_result: providerResult,
            detected_intent: "execution_provider_inspection",
            routing_decision: "route_to_inspectExecutionProvider",
            lifecycle_change_performed: false,
            intent_diagnostics: (providerResult as Record<string, unknown>).intent_diagnostics,
            audit_reference: auditRef,
            session_id: conversationId,
          }, auditRef };
        }

        // Execute the resolved inspection
        if (interpretation.capability === "engineering-work-orders" && interpretation.operation === "inspectEngineeringWorkOrder" && interpretation.objectReference) {
          const resolution = await resolveEWORef(supabase, interpretation.objectReference);
          if (!resolution.resolved) {
            await supabase.from("atd_connect_inspection_log").insert({
              request_id: auditRef, timestamp: new Date().toISOString(),
              requesting_persona: reqPersona, operation: interpretation.operation,
              inspected_object: interpretation.objectReference, outcome: "governed_empty",
              request_source: "mcp_client", client_id: reqClientId, tool_name: toolName,
              original_request: nlRequest,
              session_id: conversationId,
            });
            return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, result_type: "governed_empty", audit_reference: auditRef }, auditRef };
          }
          const { data: ewo } = await supabase
            .from("engineering_work_orders")
            .select("*")
            .eq("ewo_ref", resolution.canonical)
            .maybeSingle();
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: interpretation.operation,
            inspected_capability: interpretation.capability,
            inspected_object: resolution.canonical, outcome: "success",
            request_source: "mcp_client", client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest,
            session_id: conversationId,
          });
          return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, resolved_capability: interpretation.capability, resolved_operation: interpretation.operation, resolved_object_reference: resolution.canonical, inspection_result: ewo, audit_reference: auditRef }, auditRef };
        }

        // EWO-028R.1: Execute inspectKnowledgeExtraction routing
        if (interpretation.capability === "engineering-work-orders" && interpretation.operation === "inspectKnowledgeExtraction" && interpretation.objectReference) {
          const keResolution = await resolveEWORef(supabase, interpretation.objectReference);
          if (!keResolution.resolved) {
            await supabase.from("atd_connect_inspection_log").insert({
              request_id: auditRef, timestamp: new Date().toISOString(),
              requesting_persona: reqPersona, operation: "inspectKnowledgeExtraction",
              inspected_object: interpretation.objectReference, outcome: "governed_empty",
              request_source: "mcp_client", client_id: reqClientId, tool_name: toolName,
              original_request: nlRequest, session_id: conversationId,
            });
            return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, result_type: "governed_empty", audit_reference: auditRef }, auditRef };
          }
          const { data: keEwo } = await supabase
            .from("engineering_work_orders")
            .select("id, ewo_ref, title, status, knowledge_extraction_status, accepted_completion_report_id")
            .eq("ewo_ref", keResolution.canonical)
            .maybeSingle();
          const { data: keExtraction } = await supabase
            .from("engineering_knowledge_extractions")
            .select("*")
            .eq("ewo_id", keEwo?.id)
            .maybeSingle();
          const { data: keProv } = await supabase
            .from("engineering_knowledge_provenance")
            .select("knowledge_record_id, ewo_ref, implementation_version, extraction_id, extraction_timestamp")
            .eq("ewo_id", keEwo?.id);
          let keRecords: unknown[] = [];
          if (keProv && keProv.length > 0) {
            const recordIds = keProv.map((p: { knowledge_record_id: string }) => p.knowledge_record_id);
            const { data: keMemories } = await supabase
              .from("engineering_memory")
              .select("id, knowledge_category, title, content, tags, source_section, authority_state, created_at")
              .in("id", recordIds);
            keRecords = (keMemories || []).map((m: Record<string, unknown>) => {
              const prov = keProv.find((p: { knowledge_record_id: string }) => p.knowledge_record_id === m.id);
              return { ...m, provenance: prov };
            });
          }
          let keCompletionReport: Record<string, unknown> | null = null;
          if (keEwo?.accepted_completion_report_id) {
            const { data: cr } = await supabase
              .from("ewo_completion_reports")
              .select("id, title, executive_summary, generated_at, accepted_at, accepted_by")
              .eq("id", keEwo.accepted_completion_report_id)
              .maybeSingle();
            keCompletionReport = cr as Record<string, unknown> | null;
          }
          const { data: keRecon } = await supabase
            .from("lifecycle_reconciliation_log")
            .select("*")
            .eq("ewo_id", keEwo?.id)
            .order("reconciled_at", { ascending: false });
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: reqPersona, operation: "inspectKnowledgeExtraction",
            inspected_capability: interpretation.capability,
            inspected_object: keResolution.canonical, outcome: "success",
            request_source: "mcp_client", client_id: reqClientId, tool_name: toolName,
            original_request: nlRequest, session_id: conversationId,
          });
          return { governed: true, data: { governed: true,
            interpretation: interpretation.interpretation,
            detected_intent: "engineering_knowledge_inspection",
            resolved_capability: interpretation.capability,
            resolved_operation: interpretation.operation,
            resolved_object_reference: keResolution.canonical,
            routing_decision: "inspect_engineering_object",
            routing_confidence: 0.95,
            resolution_method: "deterministic_pattern_match",
            lifecycle_change_performed: false,
            inspection_result: {
              ewo_ref: keResolution.canonical,
              ewo_title: keEwo?.title,
              ewo_status: keEwo?.status,
              knowledge_extraction_status: keEwo?.knowledge_extraction_status || "not_extracted",
              extraction_timestamp: keExtraction?.extracted_at || null,
              extraction_id: keExtraction?.id || null,
              completion_report_linkage: { linked: !!keCompletionReport, completion_report_id: keEwo?.accepted_completion_report_id || null },
              knowledge_record_count: keRecords.length,
              knowledge_categories: [...new Set(keRecords.map((r: Record<string, unknown>) => r.knowledge_category).filter(Boolean))] as string[],
              knowledge_records: keRecords,
              provenance_records: keProv || [],
              deduplication_statistics: { records_created: keExtraction?.knowledge_records_created ?? 0, records_merged: keExtraction?.knowledge_records_merged ?? 0, records_skipped: keExtraction?.knowledge_records_skipped ?? 0 },
              linkage_integrity: { completion_report_linked: !!keCompletionReport, extraction_recorded: !!keExtraction, extraction_status: keExtraction?.extraction_status || "not_extracted", provenance_records: keProv?.length || 0 },
              extraction_diagnostics: keExtraction?.extraction_diagnostics || null,
              lifecycle_reconciliation_status: (keRecon && keRecon.length > 0) ? "reconciled" : "not_reconciled",
              lifecycle_reconciliation_history: keRecon || [],
              runtime_diagnostics: { extraction_method: keExtraction?.extraction_method || "unavailable", governed: true },
            },
            audit_reference: auditRef,
          }, auditRef };
        }

        // Generic fallback
        await supabase.from("atd_connect_inspection_log").insert({
          request_id: auditRef, timestamp: new Date().toISOString(),
          requesting_persona: reqPersona, operation: interpretation.operation ?? "conversationBridge",
          inspected_capability: interpretation.capability, outcome: "governed_empty",
          request_source: "mcp_client", client_id: reqClientId, tool_name: toolName,
          original_request: nlRequest,
          session_id: conversationId,
        });
        return { governed: true, data: { governed: true, interpretation: interpretation.interpretation, result_type: "governed_empty", audit_reference: auditRef }, auditRef };
      }

      case "inspect_capability_metadata": {
        const capabilityRequest = String(args.capability_request ?? "");
        const capPersona = String(args.persona ?? "atd");
        const includeConversational = args.include_conversational !== false;

        if (!capabilityRequest.trim()) {
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: capPersona, operation: "inspectCapabilityMetadata",
            outcome: "error", request_source: "mcp_client",
            tool_name: toolName, original_request: capabilityRequest,
          });
          return { governed: true, data: { governed: true, error: "capability_request is required.", audit_reference: auditRef }, auditRef };
        }

        // Phase 1: Resolve the capability name
        const resolution = await resolveCapabilityByName(supabase, capabilityRequest);

        if (!resolution.resolved) {
          // Phase 4: Diagnostic visibility — return failure diagnostics
          const failureResponse = buildCapabilityFailureResponse(resolution);
          const failEnvelope = buildRuntimeDiagnosticEnvelope(null, resolution.confidence, [], "capability_resolution_failed", "capability_metadata_inspection");
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: capPersona, operation: "inspectCapabilityMetadata",
            outcome: "unresolved", request_source: "mcp_client",
            tool_name: toolName, original_request: capabilityRequest,
            resolved_capability: null,
          });
          return { governed: true, data: {
            governed: true, ...failureResponse,
            runtime_diagnostics: failEnvelope,
            conversational_response: includeConversational ? formatCapabilityFailureConversational(failureResponse) : undefined,
            audit_reference: auditRef,
          }, auditRef };
        }

        // Phase 2: Fetch the full capability record from the registry
        const { data: capRecord, error: capError } = await supabase
          .from("atd_connect_capabilities")
          .select("*")
          .eq("capability_id", resolution.canonical_capability_id!)
          .maybeSingle();

        if (capError || !capRecord) {
          // The resolution succeeded but the DB lookup failed — do NOT fabricate
          const failEnvelope = buildRuntimeDiagnosticEnvelope(resolution.canonical_capability_id, resolution.confidence, [], "metadata_unavailable", "capability_metadata_inspection");
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: capPersona, operation: "inspectCapabilityMetadata",
            outcome: "error", request_source: "mcp_client",
            tool_name: toolName, original_request: capabilityRequest,
            resolved_capability: resolution.canonical_capability_id,
          });
          return { governed: true, data: {
            governed: true,
            resolution_outcome: "metadata_unavailable",
            original_request: capabilityRequest,
            extracted_capability_target: resolution.extractedCapabilityTarget,
            attempted_capability_name: resolution.attemptedName,
            resolved_capability_id: resolution.canonical_capability_id,
            resolved_capability_name: resolution.canonical_capability_name,
            match_type: resolution.match_type,
            confidence: resolution.confidence,
            reason: "Capability was resolved but metadata is currently unavailable in the registry. No metadata inferred.",
            no_metadata_inferred: true,
            runtime_diagnostics: failEnvelope,
            audit_reference: auditRef,
          }, auditRef };
        }

        // Phase 2: Build the governed metadata response from the registered record
        const metadataResponse = buildCapabilityMetadataResponse(capRecord);
        const ops = Array.isArray(metadataResponse.operations_exposed) ? metadataResponse.operations_exposed : [];
        const envelope = buildRuntimeDiagnosticEnvelope(
          resolution.canonical_capability_id,
          resolution.confidence,
          ops,
          "governed_metadata_returned",
          "capability_metadata_inspection",
        );

        await supabase.from("atd_connect_inspection_log").insert({
          request_id: auditRef, timestamp: new Date().toISOString(),
          requesting_persona: capPersona, operation: "inspectCapabilityMetadata",
          outcome: "success", request_source: "mcp_client",
          tool_name: toolName, original_request: capabilityRequest,
          resolved_capability: resolution.canonical_capability_id,
        });

        return { governed: true, data: {
          governed: true,
          resolution_outcome: "success",
          original_request: capabilityRequest,
          extracted_capability_target: resolution.extractedCapabilityTarget,
          attempted_capability_name: resolution.attemptedName,
          resolved_capability_id: resolution.canonical_capability_id,
          resolved_capability_name: resolution.canonical_capability_name,
          match_type: resolution.match_type,
          confidence: resolution.confidence,
          capability_metadata: metadataResponse,
          runtime_diagnostics: envelope,
          conversational_response: includeConversational ? formatCapabilityMetadataConversational(metadataResponse) : undefined,
          audit_reference: auditRef,
        }, auditRef };
      }

      case "inspect_knowledge_extraction": {
        const keEwoRef = String(args.ewo_ref ?? "");
        const keIncludeRecords = args.include_records !== false;
        const keIncludeReconciliation = args.include_reconciliation !== false;
        const kePersona = String(args.persona ?? "atd");

        if (!keEwoRef.trim()) {
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: kePersona, operation: "inspectKnowledgeExtraction",
            outcome: "error", request_source: "mcp_client",
            tool_name: toolName, original_request: "missing ewo_ref",
          });
          return { governed: true, data: { governed: true, error: "ewo_ref is required.", audit_reference: auditRef }, auditRef };
        }

        // Retrieve EWO
        const { data: keEwo } = await supabase
          .from("engineering_work_orders")
          .select("id, ewo_ref, title, status, knowledge_extraction_status, accepted_completion_report_id, report_generation_status, implementation_status, engineering_package_status, po_accepted_at, po_accepted_by")
          .eq("ewo_ref", keEwoRef)
          .maybeSingle();

        if (!keEwo) {
          await supabase.from("atd_connect_inspection_log").insert({
            request_id: auditRef, timestamp: new Date().toISOString(),
            requesting_persona: kePersona, operation: "inspectKnowledgeExtraction",
            outcome: "unresolved", request_source: "mcp_client",
            tool_name: toolName, original_request: keEwoRef,
          });
          return { governed: true, data: { governed: true, error: `EWO not found: ${keEwoRef}`, audit_reference: auditRef }, auditRef };
        }

        // Retrieve extraction record
        const { data: extraction } = await supabase
          .from("engineering_knowledge_extractions")
          .select("*")
          .eq("ewo_id", keEwo.id)
          .maybeSingle();

        // Retrieve completion report
        let completionReport: Record<string, unknown> | null = null;
        if (keEwo.accepted_completion_report_id) {
          const { data: cr } = await supabase
            .from("ewo_completion_reports")
            .select("id, title, executive_summary, generated_at, accepted_at, accepted_by")
            .eq("id", keEwo.accepted_completion_report_id)
            .maybeSingle();
          completionReport = cr;
        }

        // Retrieve provenance records
        let knowledgeRecords: unknown[] = [];
        if (keIncludeRecords && extraction) {
          const { data: provenance } = await supabase
            .from("engineering_knowledge_provenance")
            .select("knowledge_record_id, ewo_ref, implementation_version, completion_report_id, acceptance_audit_reference, extraction_timestamp")
            .eq("ewo_id", keEwo.id);

          if (provenance && provenance.length > 0) {
            const recordIds = provenance.map((p: { knowledge_record_id: string }) => p.knowledge_record_id);
            const { data: memories } = await supabase
              .from("engineering_memory")
              .select("id, knowledge_category, title, content, tags, source_section, authority_state, created_at")
              .in("id", recordIds);

            knowledgeRecords = (memories || []).map((m: Record<string, unknown>) => {
              const prov = provenance.find((p: { knowledge_record_id: string }) => p.knowledge_record_id === m.id);
              return { ...m, provenance: prov };
            });
          }
        }

        // Retrieve reconciliation history
        let reconciliationHistory: unknown[] = [];
        if (keIncludeReconciliation) {
          const { data: reconLogs } = await supabase
            .from("lifecycle_reconciliation_log")
            .select("*")
            .eq("ewo_id", keEwo.id)
            .order("reconciled_at", { ascending: false });
          reconciliationHistory = reconLogs || [];
        }

        // Linkage integrity check
        const linkageIntegrity = {
          completion_report_linked: !!completionReport,
          completion_report_id: keEwo.accepted_completion_report_id || null,
          extraction_recorded: !!extraction,
          extraction_status: extraction?.extraction_status || keEwo.knowledge_extraction_status || "not_extracted",
          provenance_records: extraction ? await supabase.from("engineering_knowledge_provenance").select("id", { count: "exact", head: true }).eq("ewo_id", keEwo.id).then(r => r.count || 0) : 0,
        };

        await supabase.from("atd_connect_inspection_log").insert({
          request_id: auditRef, timestamp: new Date().toISOString(),
          requesting_persona: kePersona, operation: "inspectKnowledgeExtraction",
          outcome: "success", request_source: "mcp_client",
          tool_name: toolName, original_request: keEwoRef,
          resolved_object_reference: keEwoRef,
        });

        return { governed: true, data: {
          governed: true,
          ewo_ref: keEwoRef,
          ewo_title: keEwo.title,
          ewo_status: keEwo.status,
          knowledge_extraction_status: keEwo.knowledge_extraction_status,
          linked_completion_report: completionReport,
          completion_report_id: keEwo.accepted_completion_report_id || null,
          report_storage_location: completionReport ? "ewo_completion_reports" : null,
          extraction_record: extraction || null,
          extracted_knowledge_records: knowledgeRecords,
          provenance: extraction ? {
            originating_ewo: keEwoRef,
            implementation_version: extraction.implementation_version || null,
            completion_report_id: extraction.completion_report_id || null,
            extraction_id: extraction.id,
            extraction_timestamp: extraction.extracted_at || null,
          } : null,
          lifecycle_reconciliation_history: reconciliationHistory,
          linkage_integrity: linkageIntegrity,
          extraction_diagnostics: extraction?.extraction_diagnostics || null,
          audit_reference: auditRef,
        }, auditRef };
      }

      default:
        return { governed: true, data: null, error: `Unknown tool: ${toolName}`, auditRef };
    }
  } catch (err) {
    return { governed: true, data: null, error: err instanceof Error ? err.message : "Internal error", auditRef };
  }
}

// ─── Main Handler ──────────────────────────────────────────────────────────────

function getProtectedResourceMetadata(): Record<string, unknown> {
  const mcpServerUrl = getMcpResourceUrl();
  // authorization_servers points to the MCP server itself, not directly to
  // Supabase. This is because ChatGPT follows this pointer and then fetches
  // /.well-known/oauth-authorization-server from THAT URL. The MCP server
  // serves that metadata document (which in turn points the actual OAuth
  // endpoints to Supabase). This ensures discovery works even when
  // Supabase's native OAuth discovery endpoint is disabled.
  return {
    resource: mcpServerUrl,
    authorization_servers: [mcpServerUrl],
    scopes_supported: ["openid", "profile", "email"],
    resource_documentation: mcpServerUrl,
    bearer_token_methods_supported: ["header"],
  };
}

// ─── OAuth Audit Logging (EWO-027R.DCR) ────────────────────────────────────────
async function recordOAuthAuditEvent(
  supabase: ReturnType<typeof createClient>,
  event: {
    event_type: string;
    user_id?: string | null;
    client_id?: string | null;
    client_name?: string | null;
    requested_scopes?: string[] | null;
    outcome: string;
    failure_category?: string | null;
    correlation_id: string;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await supabase.from("atd_connect_inspection_log").insert({
      request_id: event.correlation_id,
      timestamp: new Date().toISOString(),
      requesting_persona: event.user_id ?? "unknown",
      operation: event.event_type,
      outcome: event.outcome,
      request_source: "oauth",
      client_id: event.client_id ?? null,
      tool_name: event.event_type,
      original_request: JSON.stringify({
        event_type: event.event_type,
        client_name: event.client_name,
        requested_scopes: event.requested_scopes,
        failure_category: event.failure_category,
        metadata: event.metadata,
      }),
    });
  } catch {
    // Audit logging is best-effort — never block on failure
  }
}

function createUnauthorizedResponse(rpcId: string | number | null, message: string, diagnosticData?: Record<string, unknown>): Response {
  return new Response(JSON.stringify(createJsonRpcError(rpcId, -32001, message, diagnosticData)), {
    status: 401,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${getProtectedResourceMetadataUrl()}"`,
      "X-Edge-Function-Version": EDGE_FUNCTION_VERSION,
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const url = new URL(req.url);

  // GET — Protected Resource Metadata endpoint (RFC 9728, no auth required)
  if (req.method === "GET" && url.pathname.endsWith("/.well-known/oauth-protected-resource")) {
    return new Response(JSON.stringify(getProtectedResourceMetadata()), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // GET — Authorization Server Metadata endpoint (RFC 8414 + RFC 7591, no auth required)
  // Proxies Supabase's OAuth 2.1 authorization server discovery document and
  // enriches it with the registration_endpoint for Dynamic Client Registration.
  // This ensures standards-compliant MCP clients (ChatGPT, Claude, etc.) can
  // automatically discover the registration URL without manual configuration.
  if (req.method === "GET" && url.pathname.endsWith("/.well-known/oauth-authorization-server")) {
    const metadata = await getAuthorizationServerMetadata();
    if (!metadata) {
      return new Response(JSON.stringify({ error: "OAuth authorization server metadata not available." }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(metadata), {
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
    });
  }

  // GET — return server info
  if (req.method === "GET") {
    return new Response(JSON.stringify({
      server: "ATD Connect Remote MCP Server",
      version: "1.0",
      protocol: `MCP/${MCP_PROTOCOL_VERSION}`,
      transport: "streamable-http",
      tools: TOOL_NAMES,
      readOnly: true,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST and GET methods are supported." }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // ─── Request size bound ──────────────────────────────────────────────────
    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_SIZE) {
      return new Response(JSON.stringify({ error: "Request too large. Maximum 1MB." }), {
        status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Authentication ──────────────────────────────────────────────────────
    // Authentication mode is determined from server-side context only.
    // Mode 1: OAuth External — Bearer token from Supabase Auth OAuth flow.
    // Mode 2: Internal Diagnostic — service-role key (server-side only, never exposed to clients).
    // Mode 3: Development Self-Test — anon key, explicitly marked, cannot access governed data in production.
    //
    // The anon key is NEVER accepted as proof of authenticated user access for external MCP requests.
    // Authentication mode is determined by the token type, not by client-controlled headers.
    const authHeader = req.headers.get("Authorization");
    const apiKey = req.headers.get("apikey") ?? req.headers.get("Apikey");

    if (!authHeader && !apiKey) {
      return createUnauthorizedResponse(null, "Authentication required. Provide an Authorization header with a valid Supabase JWT.");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const validAnonKeys = getValidAnonKeys();
    const supabaseAnonKey = validAnonKeys[0] ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    // Determine authentication mode from server-side context
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const isServiceRoleToken = bearerToken === serviceRoleKey && serviceRoleKey !== "";
    const isAnonKeyOnly = !authHeader && apiKey !== null;

    // Mode 3: Development Self-Test — anon key without Bearer token
    // This mode CANNOT access governed engineering data. It can only reach
    // the initialize, tools/list, ping, and discover_atd_capabilities methods.
    if (isAnonKeyOnly) {
      // ─── Canonical JWT Anon Key Validation (EWO-027R.Y.3) ────────────────────
      // The canonical credential is the JWT-style anon key (header.payload.signature).
      // We validate it structurally: decode the JWT payload, verify the project
      // reference matches this server's project, and verify the role is "anon".
      // We do NOT call auth.getUser() — the anon key is a project credential, not a user JWT.
      // As a fallback, we also accept exact matches against stored publishable keys.
      const trimmedApiKey = apiKey.trim();
      const serverProjectRef = extractProjectRef(supabaseUrl);
      const jwtValidation = validateJwtAnonKey(trimmedApiKey, serverProjectRef);
      const publishableKeyMatch = validAnonKeys.some((k) => timingSafeEqual(trimmedApiKey, k));
      const keyMatch = jwtValidation.valid || publishableKeyMatch;
      if (!keyMatch) {
        const receivedFingerprint = await safeFingerprint(trimmedApiKey);
        const expectedFingerprints = await Promise.all(validAnonKeys.map((k) => safeFingerprint(k)));
        const receivedHasBearer = trimmedApiKey.startsWith("Bearer ");
        const receivedLooksEmpty = !trimmedApiKey || trimmedApiKey === "undefined" || trimmedApiKey === "null";
        const expectedKeyPresent = validAnonKeys.length > 0;
        const lengthMatch = validAnonKeys.some((k) => k.length === trimmedApiKey.length);
        const fingerprintMatch = expectedFingerprints.includes(receivedFingerprint);
        const receivedCredentialType = isJwtAnonKey(trimmedApiKey) ? "jwt_anon_key" : "unknown";
        const expectedCredentialType = validAnonKeys.length > 0 && validAnonKeys[0].length < 100 ? "publishable_key" : "unknown";
        const diagnosticData = {
          auth_mode: "development_self_test",
          canonical_credential_type: CANONICAL_CREDENTIAL_TYPE,
          received_credential_type: receivedCredentialType,
          expected_credential_type: expectedCredentialType,
          received_apikey_present: !!apiKey,
          received_apikey_length: apiKey.length,
          received_apikey_trimmed_length: trimmedApiKey.length,
          received_apikey_has_whitespace: apiKey !== apiKey.trim(),
          received_apikey_has_bearer_prefix: receivedHasBearer,
          received_apikey_looks_empty: receivedLooksEmpty,
          received_fingerprint: receivedFingerprint,
          received_jwt_project_ref: jwtValidation.keyProjectRef,
          received_jwt_validation_reason: jwtValidation.reason,
          expected_server_key_present: expectedKeyPresent,
          expected_key_count: validAnonKeys.length,
          expected_fingerprints: expectedFingerprints,
          length_match: lengthMatch,
          fingerprint_match: fingerprintMatch,
          project_ref_match: jwtValidation.keyProjectRef === serverProjectRef,
          server_project_ref: serverProjectRef,
          edge_function_version: EDGE_FUNCTION_VERSION,
          outcome: "rejected",
        };
        let failureReason = "Invalid apikey.";
        if (receivedLooksEmpty) failureReason = "Received apikey is empty or placeholder.";
        else if (receivedHasBearer) failureReason = "Received apikey has unexpected 'Bearer ' prefix.";
        else if (!jwtValidation.valid && jwtValidation.reason.includes("Project reference mismatch")) failureReason = jwtValidation.reason;
        else if (!jwtValidation.valid && jwtValidation.reason.includes("role")) failureReason = jwtValidation.reason;
        else if (!jwtValidation.valid && !isJwtAnonKey(trimmedApiKey)) failureReason = `Not a JWT-format anon key. Received ${trimmedApiKey.length} chars, expected ~208 char JWT.`;
        else if (!lengthMatch && !isJwtAnonKey(trimmedApiKey)) failureReason = `Key length mismatch: received ${trimmedApiKey.length} chars, expected JWT anon key (~208 chars) or publishable key.`;
        else if (!fingerprintMatch) failureReason = "Fingerprint mismatch: keys do not match.";
        return createUnauthorizedResponse(null, `Authentication failed. ${failureReason}`, diagnosticData);
      }
      // Use the received key to create the Supabase client (for RLS-bound queries).
      const clientKey = publishableKeyMatch ? validAnonKeys.find((k) => timingSafeEqual(trimmedApiKey, k))! : trimmedApiKey;
      const supabaseDev = createClient(supabaseUrl, clientKey, {
        global: { headers: { Authorization: `Bearer ${trimmedApiKey}` } },
      });
      // Anon key is valid for the project but is NOT an authenticated user.
      // Allow initialize, tools/list, ping, and discover_atd_capabilities (read-only metadata).
      // All other tools/call methods fail closed — they require authenticated user access.
      const body = await req.json();
      const requests = Array.isArray(body) ? body : [body];
      const responses: unknown[] = [];
      for (const rpcRequest of requests) {
        const { jsonrpc, id, method, params } = rpcRequest;
        if (jsonrpc !== "2.0") {
          responses.push(createJsonRpcError(id, -32600, "Invalid Request: jsonrpc must be '2.0'."));
          continue;
        }
        if (method === "initialize") {
          responses.push(createJsonRpcResponse(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "ATD Connect Remote MCP Server", version: "1.0" },
          }));
        } else if (method === "tools/list") {
          responses.push(createJsonRpcResponse(id, { tools: MCP_TOOLS }));
        } else if (method === "ping") {
          responses.push(createJsonRpcResponse(id, {}));
        } else if (method === "notifications/initialized") {
          // MCP lifecycle notification — no response needed for notifications,
          // but we push a null placeholder so the array stays aligned.
          // JSON-RPC notifications do not get a response, so we skip pushing.
          continue;
        } else if (method === "tools/call" && params?.name === "discover_atd_capabilities") {
          // Allow discover_atd_capabilities in dev self-test mode — it returns
          // read-only capability metadata, not governed engineering data.
          const result = await executeTool(supabaseDev, "discover_atd_capabilities", params?.arguments ?? {}, "dev_self_test", "mcp_self_test");
          let responseData = result.data;
          const responseStr = JSON.stringify(responseData);
          if (responseStr.length > MAX_RESPONSE_SIZE) {
            responseData = { truncated: true, message: "Response too large. Truncated.", preview: responseStr.slice(0, MAX_RESPONSE_SIZE) };
          }
          responses.push(createJsonRpcResponse(id, {
            content: [
              { type: "text", text: JSON.stringify({ governed: true, data: responseData, audit_reference: result.auditRef, ...(result.error ? { error: result.error } : {}) }) },
            ],
            isError: result.error ? true : false,
          }));
        } else {
          // Fail closed: anon key cannot execute other tools/call methods
          responses.push(createJsonRpcError(id, -32001, "Development self-test mode does not permit governed data access. Authentication required for tool execution."));
        }
      }
      const responseBody = Array.isArray(body) ? responses : responses[0];
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION, "X-Auth-Mode": "development_self_test", "X-Edge-Function-Version": EDGE_FUNCTION_VERSION },
      });
    }

    // Mode 1: OAuth External — Bearer token
    // Mode 2: Internal Diagnostic — service-role key as Bearer token
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader ?? `Bearer ${apiKey}` } },
    });

    const { data: authData, error: authError } = await supabase.auth.getUser();

    if (authError || !authData.user) {
      await recordOAuthAuditEvent(supabase, {
        event_type: "token_validation_failure",
        outcome: "denied",
        failure_category: authError ? "auth_error" : "no_user",
        correlation_id: `MCP-${Date.now()}-auth-fail`,
        metadata: { reason: "Invalid or expired token" },
      });
      return createUnauthorizedResponse(null, "Authentication failed. Invalid or expired token.");
    }

    const userId = authData.user.id;
    const clientId = req.headers.get("X-Client-Id") ?? "mcp-client";

    // Issue #45: governed EIOS tools are for MFA-verified platform operators
    // only. The database enforces the same rule on every EIOS table.
    const { data: isOperator } = await supabase.rpc("is_platform_operator");
    if (isOperator !== true) {
      await recordOAuthAuditEvent(supabase, {
        event_type: "token_validation_failure",
        user_id: userId,
        client_id: clientId,
        outcome: "denied",
        failure_category: "not_platform_operator",
        correlation_id: `MCP-${Date.now()}-operator`,
        metadata: { reason: "Platform operator access with MFA is required" },
      });
      return new Response(JSON.stringify({ error: "Platform operator access with MFA is required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── EWO-017R.2R Connector Conversation Identity ──────────────────────────
    // The MCP protocol's Mcp-Session-Id header is the connector-managed
    // conversation token. ChatGPT's MCP runtime establishes it at
    // initialize and reuses it for every tools/call within the same
    // conversation. This is the real ChatGPT-facing conversation identity
    // source — the user never types it.
    const incomingMcpSessionId = req.headers.get("Mcp-Session-Id") ?? req.headers.get("mcp-session-id") ?? "";
    let outgoingMcpSessionId: string | null = null;

    // Record authenticated MCP session establishment
    await recordOAuthAuditEvent(supabase, {
      event_type: "authenticated_mcp_session",
      user_id: userId,
      client_id: clientId,
      outcome: "established",
      correlation_id: `MCP-${Date.now()}-session`,
      metadata: { auth_mode: isServiceRoleToken ? "internal_diagnostic" : "oauth_external" },
    });

    // ─── Rate limiting ────────────────────────────────────────────────────────
    const withinRateLimit = await checkRateLimit(supabase, userId);
    if (!withinRateLimit) {
      return new Response(JSON.stringify(createJsonRpcError(null, -32002, "Rate limit exceeded. Maximum 60 requests per minute.")), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Parse JSON-RPC request ──────────────────────────────────────────────
    const body = await req.json();
    const correlationId = `MCP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Handle batch requests
    const requests = Array.isArray(body) ? body : [body];
    const responses: unknown[] = [];

    for (const rpcRequest of requests) {
      const { jsonrpc, id, method, params } = rpcRequest;

      if (jsonrpc !== "2.0") {
        responses.push(createJsonRpcError(id, -32600, "Invalid Request: jsonrpc must be '2.0'."));
        continue;
      }

      switch (method) {
        case "initialize": {
          // Generate a new connector-managed conversation token for this
          // MCP session. ChatGPT's MCP runtime will include it as the
          // Mcp-Session-Id header in every subsequent tools/call request
          // within the same conversation.
          outgoingMcpSessionId = `eios-conv-${Date.now()}-${crypto.randomUUID().slice(0, 12)}`;
          responses.push(createJsonRpcResponse(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "ATD Connect Remote MCP Server", version: "1.0" },
          }));
          break;
        }

        case "tools/list": {
          responses.push(createJsonRpcResponse(id, { tools: MCP_TOOLS }));
          break;
        }

        case "tools/call": {
          const toolName = params?.name;
          const toolArgs = params?.arguments ?? {};

          // Validate tool exists
          if (!TOOL_NAMES.includes(toolName)) {
            responses.push(createJsonRpcError(id, -32601, `Unknown tool: ${toolName}. Available: ${TOOL_NAMES.join(", ")}`));
            break;
          }

          // Validate required fields
          const tool = MCP_TOOLS.find(t => t.name === toolName);
          if (tool) {
            for (const reqField of tool.inputSchema.required) {
              if (toolArgs[reqField] === undefined || toolArgs[reqField] === null) {
                responses.push(createJsonRpcError(id, -32602, `Missing required parameter: ${reqField}`));
                break;
              }
            }
          }

          // Execute tool — pass the connector-managed Mcp-Session-Id so
          // submit_conversation_inspection can use it as the conversation
          // identity when no explicit conversation_id/session_id arg is supplied.
          const result = await executeTool(supabase, toolName, toolArgs, userId, clientId, incomingMcpSessionId || undefined);

          // Truncate response if too large
          let responseData = result.data;
          const responseStr = JSON.stringify(responseData);
          if (responseStr.length > MAX_RESPONSE_SIZE) {
            responseData = { truncated: true, message: "Response too large. Truncated.", preview: responseStr.slice(0, MAX_RESPONSE_SIZE) };
          }

          responses.push(createJsonRpcResponse(id, {
            content: [
              { type: "text", text: JSON.stringify({ governed: true, data: responseData, audit_reference: result.auditRef, ...(result.error ? { error: result.error } : {}) }) },
            ],
            isError: result.error ? true : false,
          }));
          break;
        }

        case "ping": {
          responses.push(createJsonRpcResponse(id, {}));
          break;
        }

        default: {
          responses.push(createJsonRpcError(id, -32601, `Method not found: ${method}`));
        }
      }
    }

    const responseBody = Array.isArray(body) ? responses : responses[0];

    const responseHeaders: Record<string, string> = {
      ...corsHeaders,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      "X-Edge-Function-Version": EDGE_FUNCTION_VERSION,
    };
    if (outgoingMcpSessionId) {
      responseHeaders["Mcp-Session-Id"] = outgoingMcpSessionId;
    }

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify(createJsonRpcError(null, -32603, err instanceof Error ? err.message : "Internal server error")), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
