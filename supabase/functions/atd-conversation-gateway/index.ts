import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";
import { invokeProvider, type ProviderInvocationRequest, type ProviderToolResult } from "../_shared/provider-adapter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ─── Production Tool Registry (mirrors src/lib/eios/toolRegistry.ts) ──────────
// This is the authoritative server-side tool definition list. The acceptance
// test fetches these via the get_tools action instead of embedding its own.

const PRODUCTION_TOOLS = [
  {
    name: "eios_list_active_ewos",
    description:
      "List all active Engineering Work Orders within the resolved tenant and project scope. Excludes completed, archived, and deleted EWOs. Returns EWO reference, title, lifecycle status, current stage, project, owner, and updated timestamp.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation identifier" },
        limit: { type: "number", description: "Max results (default 20)", default: 20 },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "eios_get_recent_work_context",
    description:
      "Retrieve governed recent work context for resuming work. Returns conversation bindings, active EWOs, recent engineering actions, pending approvals.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation identifier" },
        limit: { type: "number", description: "Max results per section (default 5)", default: 5 },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "eios_search_repository_source",
    description:
      "Search the canonical repository for filenames, symbols, functions, components, exact text, or architectural references. Returns source locations and evidence.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation identifier" },
        query: { type: "string", description: "Search query" },
        search_type: { type: "string", description: "Search type (text, symbol, filename)" },
        limit: { type: "number", description: "Max results (default 20)", default: 20 },
      },
      required: ["conversation_id", "query"],
    },
  },
  {
    name: "eios_read_repository_source",
    description:
      "Read a governed file from the repository. Returns file content with line numbers.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation identifier" },
        file_path: { type: "string", description: "Repository file path" },
        start_line: { type: "number", description: "Start line (default 1)" },
        end_line: { type: "number", description: "End line (default 200)" },
      },
      required: ["conversation_id", "file_path"],
    },
  },
  {
    name: "eios_get_architecture_records",
    description:
      "Retrieve architecture records, ADRs, implementation reports, and component documentation. Supports component-scoped queries.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation identifier" },
        component: { type: "string", description: "Component name filter" },
        limit: { type: "number", description: "Max results (default 10)", default: 10 },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "eios_get_active_ewo",
    description: "Get the active EWO for the current conversation.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation identifier" },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "eios_get_repository",
    description: "Get the canonical repository configuration.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation identifier" },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "eios_search_engineering_history",
    description: "Search engineering history.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 10)", default: 10 },
        offset: { type: "number", description: "Offset (default 0)", default: 0 },
      },
    },
  },
  {
    name: "eios_retrieve_architecture_decisions",
    description: "Retrieve architecture decisions.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 5)", default: 5 },
      },
    },
  },
  {
    name: "eios_search_engineering_memory",
    description: "Search engineering memory.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 10)", default: 10 },
      },
    },
  },
  {
    name: "eios_get_active_project",
    description: "Get the active project.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation identifier" },
      },
      required: ["conversation_id"],
    },
  },
  {
    name: "eios_get_engineering_ideas",
    description: "Get engineering ideas.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation identifier" },
        limit: { type: "number", description: "Max results (default 10)", default: 10 },
      },
      required: ["conversation_id"],
    },
  },
];

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
    const authHeader = req.headers.get("Authorization") ?? "";
    const body = await req.json();
    const action = body.action ?? "invoke_provider";

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: authError } = await userClient.auth.getUser();
    if (authError || !userData.user) {
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "invoke_provider") {
      return await handleInvokeProvider(userClient, body, userData.user.id);
    }

    if (action === "health") {
      return new Response(
        JSON.stringify({ status: "healthy", version: "2.0" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "get_tools") {
      return new Response(
        JSON.stringify({ tools: PRODUCTION_TOOLS }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "resolve_context") {
      return await handleResolveContext(userClient, body, userData.user);
    }

    if (action === "execute_tool") {
      return await handleExecuteTool(userClient, body, userData.user);
    }

    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// ─── Context Resolution ────────────────────────────────────────────────────────

async function handleResolveContext(
  client: ReturnType<typeof createClient>,
  body: { conversation_id?: string; hint_project_id?: string; hint_ewo_ref?: string },
  user: { id: string },
): Promise<Response> {
  const conversationId = body.conversation_id ?? "";
  let projectId: string | null = body.hint_project_id ?? null;
  let ewoRef: string | null = body.hint_ewo_ref ?? null;
  let repository: string | null = null;

  // Resolve organisation (tenant) membership for this user
  const { data: membership } = await client
    .from("eios_tenant_memberships")
    .select("tenant_id")
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const tenantId = membership?.tenant_id ?? null;

  // Try conversation association for EWO binding
  if (conversationId) {
    const { data: assoc } = await client
      .from("engineering_conversation_associations")
      .select("ewo_ref, project_id")
      .eq("conversation_id", conversationId)
      .eq("is_canonical", true)
      .maybeSingle();
    if (assoc) {
      ewoRef = ewoRef ?? assoc.ewo_ref;
      projectId = projectId ?? assoc.project_id;
    }
  }

  // Try repository config
  let repoQuery = client
    .from("github_repository_config")
    .select("repository_owner, repository_name, project_id")
    .eq("lifecycle_status", "active");
  if (projectId) repoQuery = repoQuery.eq("project_id", projectId);
  const { data: repoConfig } = await repoQuery.limit(1).maybeSingle();
  if (repoConfig) {
    repository = `${repoConfig.repository_owner}/${repoConfig.repository_name}`;
    const repoProjectId = repoConfig.project_id as string | null;
    // EWO-044R7: github_repository_config.project_id is text and may contain
    // the legacy value "default". engineering_work_orders.project_id is uuid,
    // so only adopt the repo config's project_id when it is a valid UUID.
    if (!projectId && repoProjectId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(repoProjectId)) {
      projectId = repoProjectId;
    }
  }

  if (!projectId) {
    const { data: defaultProject } = await client
      .from("ecc_projects")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (defaultProject) projectId = defaultProject.id;
  }

  // Resolve role
  const { data: profile } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const role = profile?.role ?? "user";

  return new Response(
    JSON.stringify({
      context: {
        tenant_id: tenantId,
        user_id: user.id,
        role,
        conversation_id: conversationId,
        project_id: projectId,
        ewo_ref: ewoRef,
        repository,
      },
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

// ─── Tool Execution (production path — mirrors toolServer.ts) ────────────────

async function handleExecuteTool(
  client: ReturnType<typeof createClient>,
  body: {
    tool_name: string;
    parameters: Record<string, unknown>;
    conversation_id?: string;
    context?: { project_id?: string; ewo_ref?: string; repository?: string; tenant_id?: string };
  },
  user: { id: string },
): Promise<Response> {
  const toolName = body.tool_name;
  const params = body.parameters ?? {};
  const conversationId = body.conversation_id ?? "";
  const ctx = {
    conversationId,
    userId: user.id,
    userRole: body.context?.role ?? "user",
    tenantId: body.context?.tenant_id ?? null,
    projectId: body.context?.project_id ?? null,
    ewoRef: body.context?.ewo_ref ?? null,
    repository: body.context?.repository ?? null,
  };

  try {
    let result: Record<string, unknown>;

    switch (toolName) {
      case "eios_list_active_ewos": {
        const limit = (params.limit as number) ?? 20;
        let q = client
          .from("engineering_work_orders")
          .select("ewo_ref, title, status, implementation_status, owner, requested_by, product_owner, updated_at, tenant_id, project_id")
          .not("status", "in", '("closed","archived","cancelled","rejected")')
          .order("updated_at", { ascending: false })
          .limit(limit);
        // EWO-044R3: Filter by tenant_id and project_id — never created_by
        if (ctx.tenantId) {
          q = q.eq("tenant_id", ctx.tenantId);
        }
        if (ctx.projectId) {
          q = q.eq("project_id", ctx.projectId);
        }
        const { data, error } = await q;
        if (error) {
          result = { tool: toolName, success: false, error: { code: "DB_ERROR", message: error.message }, result: null };
        } else {
          const activeEwos = (data ?? []).map((row: Record<string, unknown>) => ({
            ewo_ref: row.ewo_ref,
            title: row.title,
            lifecycle_status: row.status,
            current_stage: row.implementation_status ?? row.status,
            project: ctx.projectId ?? row.project_id ?? null,
            owner: row.owner ?? row.requested_by ?? row.product_owner ?? null,
            updated_at: row.updated_at,
          }));
          result = {
            tool: toolName,
            success: true,
            result: {
              active_ewos: activeEwos,
              count: activeEwos.length,
              scope: {
                tenant_id: ctx.tenantId,
                project_id: ctx.projectId,
                reason: ctx.tenantId && ctx.projectId
                  ? "Scoped to resolved organisation and project"
                  : "No organisation/project scope resolved — returning all active EWOs accessible to the authenticated user",
              },
            },
            error: null,
          };
        }
        break;
      }

      case "eios_get_recent_work_context": {
        const limit = (params.limit as number) ?? 5;
        const { data: assoc } = await client
          .from("engineering_conversation_associations")
          .select("ewo_ref, idea_ref, lifecycle_stage, updated_at")
          .eq("conversation_id", conversationId)
          .eq("is_canonical", true)
          .order("updated_at", { ascending: false })
          .limit(limit);
        const { data: activeEwos } = await client
          .from("engineering_work_orders")
          .select("ewo_ref, title, status, updated_at")
          .not("status", "in", '("closed","archived")')
          .order("updated_at", { ascending: false })
          .limit(limit);
        const { data: recentChanges } = await client
          .from("engineering_change_log")
          .select("change_ref, change_type, ewo_ref, summary, created_at")
          .order("created_at", { ascending: false })
          .limit(limit);
        result = {
          tool: toolName,
          success: true,
          result: {
            conversation_bindings: assoc ?? [],
            active_ewos: activeEwos ?? [],
            recent_engineering_actions: recentChanges ?? [],
            has_context: (assoc?.length ?? 0) > 0 || (activeEwos?.length ?? 0) > 0,
          },
          error: null,
        };
        break;
      }

      case "eios_search_repository_source": {
        const query = params.query as string;
        const limit = (params.limit as number) ?? 20;
        let repoQuery = client
          .from("github_repository_config")
          .select("repository_owner, repository_name")
          .eq("lifecycle_status", "active");
        if (ctx.projectId) repoQuery = repoQuery.eq("project_id", ctx.projectId);
        const { data: repoConfig } = await repoQuery.limit(1).maybeSingle();
        if (!repoConfig) {
          result = { tool: toolName, success: true, result: { results: [], message: "No active repository configuration found." }, error: null };
        } else {
          const repoFullName = `${repoConfig.repository_owner}/${repoConfig.repository_name}`;
          const searchUrl = `https://api.github.com/search/code?q=${encodeURIComponent(query)}+repo:${repoFullName}&per_page=${limit}`;
          const githubToken = Deno.env.get("GITHUB_TOKEN");
          const headers: Record<string, string> = { Accept: "application/vnd.github.v3+json", "User-Agent": "EIOS-Gateway" };
          if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
          const resp = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(10_000) });
          if (resp.ok) {
            const searchData = await resp.json();
            result = {
              tool: toolName,
              success: true,
              result: {
                results: (searchData.items ?? []).map((i: { name: string; path: string; html_url: string }) => ({
                  filename: i.name,
                  path: i.path,
                  url: i.html_url,
                })),
                count: searchData.items?.length ?? 0,
                repository: repoFullName,
              },
              error: null,
            };
          } else {
            result = { tool: toolName, success: true, result: { results: [], message: `Search failed: ${resp.status}`, repository: repoFullName }, error: null };
          }
        }
        break;
      }

      case "eios_read_repository_source": {
        const filePath = params.file_path as string;
        const startLine = (params.start_line as number) ?? 1;
        const endLine = (params.end_line as number) ?? 200;
        let repoQuery = client
          .from("github_repository_config")
          .select("repository_owner, repository_name, protected_paths")
          .eq("lifecycle_status", "active");
        if (ctx.projectId) repoQuery = repoQuery.eq("project_id", ctx.projectId);
        const { data: repoConfig } = await repoQuery.limit(1).maybeSingle();
        if (!repoConfig) {
          result = { tool: toolName, success: true, result: { content: null, message: "No active repository configuration found." }, error: null };
        } else {
          const protectedPaths = (repoConfig.protected_paths ?? []) as string[];
          let blocked = false;
          for (const pp of protectedPaths) {
            if (filePath.startsWith(pp) || filePath === pp) {
              result = { tool: toolName, success: false, error: { code: "PROTECTED_PATH", message: `Path "${filePath}" is protected.` }, result: null };
              blocked = true;
              break;
            }
          }
          if (!blocked) {
            const repoFullName = `${repoConfig.repository_owner}/${repoConfig.repository_name}`;
            const url = `https://api.github.com/repos/${repoFullName}/contents/${filePath}`;
            const githubToken = Deno.env.get("GITHUB_TOKEN");
            const headers: Record<string, string> = { Accept: "application/vnd.github.v3.raw", "User-Agent": "EIOS-Gateway" };
            if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
            const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
            if (resp.ok) {
              const content = await resp.text();
              const lines = content.split("\n");
              const end = Math.min(endLine, startLine + 199);
              const sliced = lines.slice(startLine - 1, end);
              const numbered = sliced.map((line, i) => `${startLine + i}\t${line}`).join("\n");
              result = { tool: toolName, success: true, result: { file_path: filePath, content: numbered, total_lines: lines.length, range: { start: startLine, end }, repository: repoFullName }, error: null };
            } else {
              result = { tool: toolName, success: true, result: { content: null, message: `Failed to read file: ${resp.status}` }, error: null };
            }
          }
        }
        break;
      }

      case "eios_get_architecture_records": {
        const component = params.component as string | undefined;
        const limit = (params.limit as number) ?? 10;
        let recordsQuery = client
          .from("engineering_records_library")
          .select("record_ref, record_type, title, ewo_ref, status, content, created_at, updated_at")
          .eq("status", "active")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (component) {
          recordsQuery = recordsQuery.or(`title.ilike.%${component}%,content::text.ilike.%${component}%`);
        }
        const { data: records } = await recordsQuery;
        let decisionsQuery = client
          .from("ecc_decisions")
          .select("id, title, decision, reasoning, context, tags, created_at")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (component) {
          decisionsQuery = decisionsQuery.or(`title.ilike.%${component}%,context.ilike.%${component}%,decision.ilike.%${component}%`);
        }
        const { data: decisions } = await decisionsQuery;
        const { data: memory } = await client
          .from("engineering_memory")
          .select("title, content, knowledge_category, tags, created_at")
          .eq("knowledge_category", "architecture")
          .order("created_at", { ascending: false })
          .limit(limit);
        result = {
          tool: toolName,
          success: true,
          result: {
            architecture_records: records ?? [],
            architecture_decisions: decisions ?? [],
            architecture_memory: memory ?? [],
            component_filter: component ?? null,
          },
          error: null,
        };
        break;
      }

      case "eios_get_active_ewo": {
        const { data: assoc } = await client
          .from("engineering_conversation_associations")
          .select("ewo_ref")
          .eq("conversation_id", conversationId)
          .eq("is_canonical", true)
          .maybeSingle();
        if (assoc?.ewo_ref) {
          const { data: ewo } = await client
            .from("engineering_work_orders")
            .select("*")
            .eq("ewo_ref", assoc.ewo_ref)
            .maybeSingle();
          result = { tool: toolName, success: true, result: { ewo }, error: null };
        } else {
          result = { tool: toolName, success: true, result: { ewo: null, message: "No active EWO for this conversation." }, error: null };
        }
        break;
      }

      case "eios_get_repository": {
        let repoQuery = client
          .from("github_repository_config")
          .select("*")
          .eq("lifecycle_status", "active");
        if (ctx.projectId) repoQuery = repoQuery.eq("project_id", ctx.projectId);
        const { data: repoConfig } = await repoQuery.limit(1).maybeSingle();
        result = { tool: toolName, success: true, result: { repository: repoConfig }, error: null };
        break;
      }

      case "eios_search_engineering_history": {
        const query = params.query as string | undefined;
        const limit = (params.limit as number) ?? 10;
        const offset = (params.offset as number) ?? 0;
        let q = client
          .from("engineering_work_orders")
          .select("ewo_ref, title, status, created_at, updated_at")
          .order("created_at", { ascending: false })
          .limit(limit)
          .range(offset, offset + limit - 1);
        if (query) q = q.ilike("title", `%${query}%`);
        const { data: history } = await q;
        result = { tool: toolName, success: true, result: { history }, error: null };
        break;
      }

      case "eios_retrieve_architecture_decisions": {
        const limit = (params.limit as number) ?? 5;
        const { data: decisions } = await client
          .from("ecc_decisions")
          .select("*")
          .in("status", ["accepted", "active", "approved"])
          .order("created_at", { ascending: false })
          .limit(limit);
        result = { tool: toolName, success: true, result: { decisions }, error: null };
        break;
      }

      case "eios_search_engineering_memory": {
        const query = params.query as string | undefined;
        const limit = (params.limit as number) ?? 10;
        let q = client
          .from("engineering_memory")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (query) q = q.ilike("content", `%${query}%`);
        const { data: memory } = await q;
        result = { tool: toolName, success: true, result: { memory }, error: null };
        break;
      }

      case "eios_get_active_project": {
        if (ctx.projectId) {
          const { data: project } = await client
            .from("ecc_product")
            .select("*")
            .eq("id", ctx.projectId)
            .maybeSingle();
          result = { tool: toolName, success: true, result: { project }, error: null };
        } else {
          result = { tool: toolName, success: true, result: { project: null, message: "No active project resolved." }, error: null };
        }
        break;
      }

      case "eios_get_engineering_ideas": {
        const limit = (params.limit as number) ?? 10;
        let q = client
          .from("engineering_idea")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (ctx.projectId) q = q.eq("project_id", ctx.projectId);
        const { data: ideas } = await q;
        result = { tool: toolName, success: true, result: { ideas }, error: null };
        break;
      }

      default:
        result = { tool: toolName, success: false, error: { code: "UNKNOWN_TOOL", message: `Unknown tool: ${toolName}` }, result: null };
    }

    // ── Tool Audit Record ──────────────────────────────────────────────────
    try {
      await client.from("atd_connect_inspection_log").insert({
        request_id: `tool-${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        requesting_persona: "atd",
        operation: "execute_tool",
        inspected_capability: toolName,
        outcome: result.success ? "success" : "error",
        request_source: "conversational",
        original_request: JSON.stringify(params).slice(0, 2000),
        session_id: conversationId,
        resolved_capability: toolName,
        resolved_operation: toolName,
      });
    } catch (auditErr) {
      console.warn("[EIOS] Tool audit insert failed:", auditErr instanceof Error ? auditErr.message : String(auditErr));
    }

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ tool: toolName, success: false, error: { code: "EXCEPTION", message: e instanceof Error ? e.message : String(e) }, result: null }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
}

// ─── Provider Invocation via IExecutionProviderAdapter ─────────────────────────

async function handleInvokeProvider(
  client: ReturnType<typeof createClient>,
  body: {
    messages: Array<{ role: string; content: string }>;
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    system_prompt?: string;
    conversation_id?: string;
    prior_tool_results?: ProviderToolResult[];
    continuation?: unknown;
    explicit_provider_config_id?: string;
  },
  userId: string,
): Promise<Response> {
  const messages = body.messages ?? [];
  const tools = body.tools ?? [];
  const systemPrompt = body.system_prompt ?? "";
  const priorToolResults = body.prior_tool_results ?? [];

  const adapterReq: ProviderInvocationRequest = {
    messages: messages.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    })),
    tools,
    systemPrompt,
    temperature: 0.4,
    maxTokens: 4096,
    conversationId: body.conversation_id ?? "",
    userId,
    priorToolResults: priorToolResults.length > 0 ? priorToolResults : undefined,
  };

  const result = await invokeProvider(client, adapterReq, body.explicit_provider_config_id);

  if (result.kind === "tool_calls") {
    return new Response(
      JSON.stringify({
        kind: "tool_calls",
        tool_calls: result.toolCalls,
        diagnostics: result.diagnostics,
        continuation: body.continuation,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
      kind: "final_response",
      content: result.content,
      diagnostics: result.diagnostics,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}
