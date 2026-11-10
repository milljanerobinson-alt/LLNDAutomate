import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GITHUB_API_BASE = "https://api.github.com";

function githubHeaders(token: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "EIOS-Bootstrap",
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
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: response.ok, status: response.status, data };
}

// Patterns that must NEVER be committed — match actual secret VALUES, not code referencing them
const SECRET_PATTERNS = [
  /sk-proj-[a-zA-Z0-9]{20,}/,
  /sk-[a-zA-Z0-9]{40,}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /github_pat_[a-zA-Z0-9]{82}/,
  /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

// Files/dirs that must be excluded from the bootstrap
const EXCLUDE_PATTERNS = [
  /^\.env$/,
  /^\.env\./,
  /^\.git\//,
  /^node_modules\//,
  /^dist\//,
  /^dist-ssr\//,
  /\.log$/,
  /npm-debug\.log/,
  /^\.bolt\//,
  /^\.vscode\//,
  /^\.idea\//,
  /\.DS_Store$/,
  /^vite\.config\.ts\.timestamp/,
  /^investigation.*\.pdf$/,
];

function shouldExclude(path: string): boolean {
  return EXCLUDE_PATTERNS.some(p => p.test(path));
}

function containsSecret(content: string): boolean {
  return SECRET_PATTERNS.some(p => p.test(content));
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
    const body = await req.json();
    const { owner, repo, files, commitMessage, credentialRef, credential_ref } = body;

    if (!owner || !repo) {
      return new Response(JSON.stringify({ error: "Missing owner or repo" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = Deno.env.get(credential_ref || credentialRef || "github_token") || "";
    if (!token) {
      return new Response(JSON.stringify({ error: "GitHub token not configured in edge function secrets" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Check if repo exists ──────────────────────────────────
    if (operation === "check-repo") {
      const result = await githubFetch(`/repos/${owner}/${repo}`, token);
      if (result.ok) {
        const repoData = result.data as Record<string, unknown>;
        return new Response(JSON.stringify({
          exists: true,
          default_branch: repoData.default_branch,
          private: repoData.private,
          full_name: repoData.full_name,
          html_url: repoData.html_url,
          empty: repoData.size === 0,
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (result.status === 404) {
        return new Response(JSON.stringify({ exists: false }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: `GitHub API error: ${result.status}` }), {
        status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Check token scopes ─────────────────────────────────────
    if (operation === "check-token") {
      const response = await fetch(`${GITHUB_API_BASE}/user`, {
        headers: githubHeaders(token),
      });
      const scopes = response.headers.get("x-oauth-scopes") || "";
      const userData = await response.json();
      return new Response(JSON.stringify({
        authenticated: response.ok,
        username: userData.login || null,
        scopes: scopes,
        has_repo_scope: scopes.includes("repo"),
        has_workflow_scope: scopes.includes("workflow"),
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ─── Create repository ──────────────────────────────────────
    if (operation === "create-repo") {
      const result = await githubFetch("/user/repos", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: repo,
          private: true,
          auto_init: true,
          description: "EIOS — Engineering Intelligence Operating System",
        }),
      });

      if (!result.ok) {
        const errData = result.data as Record<string, unknown>;
        return new Response(JSON.stringify({
          error: `Repository creation failed: ${errData?.message || result.status}`,
          details: errData,
        }), { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const repoData = result.data as Record<string, unknown>;
      return new Response(JSON.stringify({
        success: true,
        full_name: repoData.full_name,
        html_url: repoData.html_url,
        default_branch: repoData.default_branch,
        private: repoData.private,
      }), { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ─── Bootstrap commit (Contents API) ───────────────────────
    //
    // Uses the GitHub Contents API (PUT /repos/{owner}/{repo}/contents/{path})
    // instead of the Git Data API, because fine-grained PATs with Contents
    // read/write permission can use the Contents API but may be blocked from
    // the Git Data API (git/trees, git/commits, git/refs).
    //
    // Each file creates its own commit on main. For a bootstrap of ~980 files
    // this produces ~980 commits, which is acceptable for an initial
    // repository population.
    if (operation === "bootstrap-commit") {
      if (!files || !Array.isArray(files) || files.length === 0) {
        return new Response(JSON.stringify({ error: "Missing files array" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Safety scan — only scan text files, not base64-encoded binary
      const secretHits: string[] = [];
      for (const f of files) {
        if (f.encoding === "base64") continue;
        if (containsSecret(f.content)) {
          secretHits.push(f.path);
        }
      }
      if (secretHits.length > 0) {
        return new Response(JSON.stringify({
          error: "Secret scan failed — refusing to commit files with embedded secrets",
          files_with_secrets: secretHits,
        }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Check if main branch exists (repo may be empty with no commits)
      const branchResult = await githubFetch(`/repos/${owner}/${repo}/branches/main`, token);
      const isEmptyRepo = !branchResult.ok;

      // If empty, initialize with .gitkeep so main branch exists
      if (isEmptyRepo) {
        const initResult = await githubFetch(`/repos/${owner}/${repo}/contents/.gitkeep`, token, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "chore: initialize repository",
            content: btoa("EIOS canonical repository"),
          }),
        });
        if (!initResult.ok) {
          const errData = initResult.data as Record<string, unknown>;
          return new Response(JSON.stringify({
            error: `Repository initialization failed: ${errData?.message || initResult.status}`,
            details: errData,
          }), { status: initResult.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      // Commit each file via Contents API
      // Process sequentially to avoid race conditions on the main branch ref
      let committed = 0;
      let lastCommitSha: string | null = null;
      const failedFiles: { path: string; error: string }[] = [];

      for (const f of files) {
        const filePath = f.path;
        const fileContent = f.encoding === "base64"
          ? f.content  // already base64-encoded
          : btoa(unescape(encodeURIComponent(f.content))); // text → base64

        const putResult = await githubFetch(
          `/repos/${owner}/${repo}/contents/${filePath}`,
          token,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: commitMessage || "chore: bootstrap EIOS canonical GitHub repository",
              content: fileContent,
              branch: "main",
            }),
          },
        );

        if (putResult.ok) {
          committed++;
          const putData = putResult.data as Record<string, unknown>;
          lastCommitSha = (putData.commit as Record<string, unknown>)?.sha as string;
        } else {
          const errData = putResult.data as Record<string, unknown>;
          failedFiles.push({
            path: filePath,
            error: (errData?.message as string) || `HTTP ${putResult.status}`,
          });
        }
      }

      if (failedFiles.length > 0) {
        return new Response(JSON.stringify({
          error: `${failedFiles.length} files failed to commit`,
          failed_files: failedFiles.slice(0, 50).map(f => f.path),
          failed_details: failedFiles.slice(0, 10),
          total_failed: failedFiles.length,
          total_committed: committed,
          last_commit_sha: lastCommitSha,
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({
        success: true,
        commit_sha: lastCommitSha,
        commit_url: lastCommitSha
          ? `https://github.com/${owner}/${repo}/commit/${lastCommitSha}`
          : null,
        files_committed: committed,
        empty_repo_initialized: isEmptyRepo,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ─── Verify remote files ────────────────────────────────────
    if (operation === "verify-remote") {
      const { paths } = body;
      const results: Record<string, unknown> = {};

      // Check repo accessible
      const repoResult = await githubFetch(`/repos/${owner}/${repo}`, token);
      results.repo_accessible = repoResult.ok;
      if (repoResult.ok) {
        const repoData = repoResult.data as Record<string, unknown>;
        results.default_branch = repoData.default_branch;
        results.private = repoData.private;
        results.size = repoData.size;
      }

      // Check main branch
      const branchResult = await githubFetch(`/repos/${owner}/${repo}/branches/main`, token);
      results.main_branch_exists = branchResult.ok;
      if (branchResult.ok) {
        const branchData = branchResult.data as Record<string, unknown>;
        const commit = branchData.commit as Record<string, unknown>;
        results.main_commit_sha = commit?.sha;
      }

      // Check specific paths
      if (paths && Array.isArray(paths)) {
        const pathResults: Record<string, boolean> = {};
        for (const p of paths) {
          const fileResult = await githubFetch(
            `/repos/${owner}/${repo}/contents/${p}?ref=main`,
            token,
          );
          pathResults[p] = fileResult.ok;
        }
        results.paths = pathResults;
      }

      // Check workflow runs (without triggering)
      const wfResult = await githubFetch(
        `/repos/${owner}/${repo}/actions/workflows`,
        token,
      );
      results.workflows_accessible = wfResult.ok;
      if (wfResult.ok) {
        const wfData = wfResult.data as Record<string, unknown>;
        const workflows = (wfData.workflows as Record<string, unknown>[]) || [];
        results.workflows = workflows.map((w) => ({
          id: w.id,
          name: w.name,
          path: w.path,
          state: w.state,
        }));
      }

      return new Response(JSON.stringify(results), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown operation: ${operation}` }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
