import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/**
 * EWO-034R.2 — GitHub Operations Edge Function
 *
 * Proxies all GitHub REST API calls from the EIOS frontend to GitHub.
 * The GitHub token is stored ONLY in edge function secrets and is NEVER
 * exposed to the browser or stored in audit payloads.
 *
 * Supported operations:
 *   /inspect-repo       — GET /repos/{owner}/{repo}
 *   /get-branch         — GET /repos/{owner}/{repo}/branches/{branch}
 *   /create-branch      — POST /repos/{owner}/{repo}/git/refs
 *   /delete-branch      — DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}
 *   /read-file          — GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
 *   /commit-file        — PUT /repos/{owner}/{repo}/contents/{path}
 *   /delete-file        — DELETE /repos/{owner}/{repo}/contents/{path}
 *   /compare-branches   — GET /repos/{owner}/{repo}/compare/{base}...{head}
 *   /trigger-workflow   — POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches
 *   /get-workflow-run   — GET /repos/{owner}/{repo}/actions/runs/{run_id}
 *   /get-check-runs     — GET /repos/{owner}/{repo}/commits/{ref}/check-runs
 *   /create-pr          — POST /repos/{owner}/{repo}/pulls
 */

const GITHUB_API_BASE = "https://api.github.com";

interface RequestBody {
  owner: string;
  repo: string;
  branch?: string;
  base_sha?: string;
  path?: string;
  ref?: string;
  content?: string;
  commit_message?: string;
  sha?: string | null;
  credential_ref?: string;
  workflow_file?: string;
  inputs?: Record<string, string>;
  run_id?: number;
  head?: string;
  base?: string;
  title?: string;
  body?: string;
}

async function getGithubToken(credentialRef: string): Promise<string> {
  // The token is stored in edge function secrets under the credential_ref name.
  // Try to get it from the environment.
  const token = Deno.env.get(credentialRef) || Deno.env.get("GITHUB_TOKEN") || "";
  if (!token) {
    throw new Error(`GitHub credential '${credentialRef}' is not configured. Set it in edge function secrets.`);
  }
  return token;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "EIOS-Autonomous-Execution-Pipeline",
  };
}

async function githubFetch(path: string, token: string, options: RequestInit = {}): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...options,
    headers: {
      ...githubHeaders(token),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { ok: response.ok, status: response.status, data };
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
    const url = new URL(req.url);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const operation = pathSegments[pathSegments.length - 1] || "";
    const body: RequestBody = await req.json();

    if (!body.owner || !body.repo) {
      return new Response(
        JSON.stringify({ error: "Missing owner or repo" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const token = await getGithubToken(body.credential_ref || "github_token");

    // ─── Inspect Repository ─────────────────────────────────────
    if (operation === "inspect-repo") {
      const result = await githubFetch(`/repos/${body.owner}/${body.repo}`, token);
      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: `Repository not accessible: ${(result.data as Record<string, unknown>)?.message || result.status}` }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const repoData = result.data as Record<string, unknown>;
      const repoSize = (repoData.size as number) ?? 0;
      return new Response(
        JSON.stringify({
          accessible: true,
          exists: true,
          empty: repoSize === 0,
          size: repoSize,
          default_branch: repoData.default_branch,
          private: repoData.private,
          full_name: repoData.full_name,
          html_url: repoData.html_url,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Get Branch ──────────────────────────────────────────────
    if (operation === "get-branch") {
      const result = await githubFetch(`/repos/${body.owner}/${body.repo}/branches/${body.branch}`, token);
      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: `Branch '${body.branch}' not found` }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const branchData = result.data as Record<string, unknown>;
      const commit = branchData.commit as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          name: branchData.name,
          commit_sha: commit?.sha,
          protected: branchData.protected,
          url: `https://github.com/${body.owner}/${body.repo}/tree/${body.branch}`,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Create Branch ───────────────────────────────────────────
    if (operation === "create-branch") {
      // GitHub API: POST /repos/{owner}/{repo}/git/refs
      const result = await githubFetch(`/repos/${body.owner}/${body.repo}/git/refs`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ref: `refs/heads/${body.branch}`,
          sha: body.base_sha,
        }),
      });

      if (!result.ok) {
        const errData = result.data as Record<string, unknown>;
        return new Response(
          JSON.stringify({ error: `Branch creation failed: ${errData?.message || result.status}` }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          branch: body.branch,
          branch_url: `https://github.com/${body.owner}/${body.repo}/tree/${body.branch}`,
        }),
        { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Delete Branch ───────────────────────────────────────────
    if (operation === "delete-branch") {
      const result = await githubFetch(`/repos/${body.owner}/${body.repo}/git/refs/heads/${body.branch}`, token, {
        method: "DELETE",
      });

      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: `Branch deletion failed: ${result.status}` }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Read File ───────────────────────────────────────────────
    if (operation === "read-file") {
      const refParam = body.ref ? `?ref=${encodeURIComponent(body.ref)}` : "";
      const result = await githubFetch(
        `/repos/${body.owner}/${body.repo}/contents/${body.path}${refParam}`,
        token,
      );

      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: `File not found: ${body.path}` }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const fileData = result.data as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          path: fileData.path,
          content: fileData.content,
          sha: fileData.sha,
          encoding: fileData.encoding,
          size: fileData.size,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Commit File (Create or Update) ──────────────────────────
    if (operation === "commit-file") {
      const payload: Record<string, unknown> = {
        message: body.commit_message,
        content: body.content,
        branch: body.branch,
      };
      if (body.sha) {
        payload.sha = body.sha;
      }

      const result = await githubFetch(
        `/repos/${body.owner}/${body.repo}/contents/${body.path}`,
        token,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      if (!result.ok) {
        const errData = result.data as Record<string, unknown>;
        return new Response(
          JSON.stringify({ error: `Commit failed: ${errData?.message || result.status}` }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const commitData = result.data as Record<string, unknown>;
      const commit = commitData.commit as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          success: true,
          commit_sha: commit?.sha,
          commit_url: commit?.html_url,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Delete File ─────────────────────────────────────────────
    if (operation === "delete-file") {
      const result = await githubFetch(
        `/repos/${body.owner}/${body.repo}/contents/${body.path}`,
        token,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: body.commit_message,
            sha: body.sha,
            branch: body.branch,
          }),
        },
      );

      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: `File deletion failed: ${result.status}` }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Compare Branches ────────────────────────────────────────
    if (operation === "compare-branches") {
      const result = await githubFetch(
        `/repos/${body.owner}/${body.repo}/compare/${body.base}...${body.head}`,
        token,
      );

      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: `Comparison failed: ${result.status}` }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const compareData = result.data as Record<string, unknown>;
      const commits = (compareData.commits as Record<string, unknown>[]) || [];
      const files = (compareData.files as Record<string, unknown>[]) || [];
      return new Response(
        JSON.stringify({
          html_url: compareData.html_url,
          commits: commits.map((c) => c.sha as string),
          files: files.map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
          })),
          total_commits: compareData.total_commits,
          total_additions: compareData.total_additions,
          total_deletions: compareData.total_deletions,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Trigger Workflow ────────────────────────────────────────
    if (operation === "trigger-workflow") {
      const result = await githubFetch(
        `/repos/${body.owner}/${body.repo}/actions/workflows/${body.workflow_file}/dispatches`,
        token,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ref: body.ref,
            inputs: body.inputs || {},
          }),
        },
      );

      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: `Workflow dispatch failed: ${result.status}` }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // The dispatch endpoint returns 204 with no body.
      // We need to poll for the run — return a placeholder.
      return new Response(
        JSON.stringify({
          success: true,
          workflow_run_id: null, // Will be resolved by polling
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Get Workflow Run ────────────────────────────────────────
    if (operation === "get-workflow-run") {
      const result = await githubFetch(
        `/repos/${body.owner}/${body.repo}/actions/runs/${body.run_id}`,
        token,
      );

      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: `Workflow run not found: ${body.run_id}` }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const runData = result.data as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: runData.id,
          name: runData.name,
          status: runData.status,
          conclusion: runData.conclusion,
          html_url: runData.html_url,
          head_sha: runData.head_sha,
          created_at: runData.created_at,
          updated_at: runData.updated_at,
          run_attempt: runData.run_attempt,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Get Check Runs ──────────────────────────────────────────
    if (operation === "get-check-runs") {
      const result = await githubFetch(
        `/repos/${body.owner}/${body.repo}/commits/${body.ref}/check-runs`,
        token,
      );

      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: `Check runs not found for ${body.ref}` }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const checkData = result.data as Record<string, unknown>;
      const checkRuns = (checkData.check_runs as Record<string, unknown>[]) || [];
      return new Response(
        JSON.stringify({
          check_runs: checkRuns.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            html_url: r.html_url,
            started_at: r.started_at,
            completed_at: r.completed_at,
          })),
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Create Pull Request ─────────────────────────────────────
    if (operation === "create-pr") {
      const result = await githubFetch(
        `/repos/${body.owner}/${body.repo}/pulls`,
        token,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: body.title,
            head: body.head,
            base: body.base,
            body: body.body,
          }),
        },
      );

      if (!result.ok) {
        const errData = result.data as Record<string, unknown>;
        return new Response(
          JSON.stringify({ error: `PR creation failed: ${errData?.message || result.status}` }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const prData = result.data as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          number: prData.number,
          html_url: prData.html_url,
          state: prData.state,
          mergeable: prData.mergeable,
        }),
        { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Get Latest Workflow Run for a Branch ────────────────────
    if (operation === "get-latest-workflow-run") {
      const result = await githubFetch(
        `/repos/${body.owner}/${body.repo}/actions/runs?branch=${body.branch}&per_page=1`,
        token,
      );

      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: `Failed to list workflow runs: ${result.status}` }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const runsData = result.data as Record<string, unknown>;
      const runs = (runsData.workflow_runs as Record<string, unknown>[]) || [];
      if (runs.length === 0) {
        return new Response(
          JSON.stringify({ error: "No workflow runs found for this branch" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const run = runs[0];
      return new Response(
        JSON.stringify({
          id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          html_url: run.html_url,
          head_sha: run.head_sha,
          created_at: run.created_at,
          updated_at: run.updated_at,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown operation: ${operation}` }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
