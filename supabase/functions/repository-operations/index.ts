/**
 * EWO-034 — Repository Operations Edge Function
 *
 * Handles governed repository file operations:
 *   - POST /repository/write   — Write file content
 *   - POST /repository/delete   — Delete file
 *   - GET  /repository/read     — Read file content
 *   - POST /repository/build    — Execute build
 *   - POST /repository/test     — Execute tests
 *
 * All operations are audited and restricted to permitted paths.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import { operatorDeniedResponse, requirePlatformOperator } from "../_shared/platform-operator.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const PERMITTED_DIRECTORIES = ["src/", "supabase/", "public/"];
const PROTECTED_PATTERNS = [
  /\.env/i,
  /\.env\./i,
  /secrets?\./i,
  /credentials?\./i,
  /api[_-]?key/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.ssh\//i,
];

const MAX_FILE_SIZE = 512_000; // 512 KB

function validatePath(path: string): { valid: boolean; reason: string | null } {
  if (!path || path.trim() === "") {
    return { valid: false, reason: "Empty path" };
  }
  const normalized = path.replace(/^\/+/, "");
  if (normalized.includes("..") || normalized.includes("\0")) {
    return { valid: false, reason: "Path traversal detected" };
  }
  const inPermitted = PERMITTED_DIRECTORIES.some((dir) =>
    normalized.startsWith(dir)
  );
  if (!inPermitted) {
    return { valid: false, reason: `Path not in permitted directories: ${path}` };
  }
  for (const pattern of PROTECTED_PATTERNS) {
    if (pattern.test(normalized)) {
      return { valid: false, reason: `Protected file: ${path}` };
    }
  }
  return { valid: true, reason: null };
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
    const path = url.pathname.replace("/repository-operations", "");

    // ─── Read file ─────────────────────────────────────────────
    if (req.method === "GET" && path === "/read") {
      const filePath = url.searchParams.get("path");
      if (!filePath) {
        return new Response(JSON.stringify({ error: "Missing path parameter" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const validation = validatePath(filePath);
      if (!validation.valid) {
        return new Response(JSON.stringify({ error: validation.reason }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        const fullPath = `${Deno.cwd()}/${filePath.replace(/^\/+/, "")}`;
        const content = await Deno.readTextFile(fullPath);
        return new Response(content, {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "text/plain" },
        });
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          return new Response("", { status: 404, headers: corsHeaders });
        }
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ─── Write file ────────────────────────────────────────────
    if (req.method === "POST" && path === "/write") {
      const body = await req.json();
      const { path: filePath, content, action, execution_id, ewo_ref, actor } = body;

      if (!filePath || content === undefined) {
        return new Response(JSON.stringify({ error: "Missing path or content" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const validation = validatePath(filePath);
      if (!validation.valid) {
        return new Response(JSON.stringify({ error: validation.reason }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (content.length > MAX_FILE_SIZE) {
        return new Response(
          JSON.stringify({ error: `File content exceeds max size ${MAX_FILE_SIZE}` }),
          { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const fullPath = `${Deno.cwd()}/${filePath.replace(/^\/+/, "")}`;

      // Ensure parent directory exists
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      try {
        await Deno.mkdir(dir, { recursive: true });
      } catch {
        // Directory may already exist
      }

      await Deno.writeTextFile(fullPath, content);

      // Audit log
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      await supabase.from("repository_change_audit").insert({
        audit_ref: `WRITE-${Date.now()}`,
        execution_id: execution_id || "unknown",
        ewo_ref: ewo_ref || "unknown",
        actor: actor || "system",
        operation: "write",
        file_path: filePath,
        action: action || "modify",
        content_size: content.length,
        created_at: new Date().toISOString(),
      }).then(() => {}).catch(() => {});

      return new Response(
        JSON.stringify({ success: true, path: filePath, bytes_written: content.length }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Delete file ────────────────────────────────────────────
    if (req.method === "POST" && path === "/delete") {
      const body = await req.json();
      const { path: filePath, execution_id, ewo_ref, actor } = body;

      if (!filePath) {
        return new Response(JSON.stringify({ error: "Missing path" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const validation = validatePath(filePath);
      if (!validation.valid) {
        return new Response(JSON.stringify({ error: validation.reason }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const fullPath = `${Deno.cwd()}/${filePath.replace(/^\/+/, "")}`;
      try {
        await Deno.remove(fullPath);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          return new Response(
            JSON.stringify({ success: true, path: filePath, note: "File did not exist" }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        throw err;
      }

      return new Response(
        JSON.stringify({ success: true, path: filePath }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Build ──────────────────────────────────────────────────
    if (req.method === "POST" && path === "/build") {
      const body = await req.json();
      const command = body.command || "npm run build";

      const cmd = new Deno.Command("sh", {
        args: ["-c", command],
        cwd: Deno.cwd(),
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stdout, stderr } = await cmd.output();
      const output = new TextDecoder().decode(stdout) + "\n" + new TextDecoder().decode(stderr);

      return new Response(
        JSON.stringify({
          success: code === 0,
          output,
          errors: code !== 0 ? [output] : [],
          warnings: [],
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Test ───────────────────────────────────────────────────
    if (req.method === "POST" && path === "/test") {
      const body = await req.json();
      const testPattern = body.test_pattern || "npx vitest run";

      const cmd = new Deno.Command("sh", {
        args: ["-c", testPattern],
        cwd: Deno.cwd(),
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stdout, stderr } = await cmd.output();
      const output = new TextDecoder().decode(stdout) + "\n" + new TextDecoder().decode(stderr);

      // Parse vitest output for pass/fail counts
      const passMatch = output.match(/(\d+)\s+passed/);
      const failMatch = output.match(/(\d+)\s+failed/);
      const totalMatch = output.match(/(\d+)\s+(?:tests|test)/);
      const passed = passMatch ? parseInt(passMatch[1]) : 0;
      const failed = failMatch ? parseInt(failMatch[1]) : 0;
      const total = totalMatch ? parseInt(totalMatch[1]) : passed + failed;

      return new Response(
        JSON.stringify({
          success: code === 0 && failed === 0,
          total,
          passed,
          failed,
          output,
          test_details: [],
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Git Branch Creation ─────────────────────────────────────
    if (req.method === "POST" && path === "/git-branch") {
      const body = await req.json();
      const { branch_name, base_branch, ewo_ref } = body;

      if (!branch_name || !base_branch) {
        return new Response(JSON.stringify({ error: "Missing branch_name or base_branch" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Validate branch name
      if (!branch_name.startsWith("ewo/")) {
        return new Response(JSON.stringify({ error: "Branch must start with ewo/" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Never allow writing to production branches
      const prodBranches = ["main", "master", "production", "prod", "release"];
      if (prodBranches.includes(branch_name.toLowerCase())) {
        return new Response(JSON.stringify({ error: "Cannot create production branch" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        // Check if git repo exists
        try {
          await Deno.stat(".git");
        } catch {
          // Not a git repo — initialize one
          const initCmd = new Deno.Command("git", { args: ["init"], cwd: Deno.cwd(), stdout: "piped", stderr: "piped" });
          await initCmd.output();
        }

        // Create branch from base
        const checkoutCmd = new Deno.Command("git", {
          args: ["checkout", "-b", branch_name, base_branch],
          cwd: Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        });
        const { code: checkoutCode, stderr: checkoutErr } = await checkoutCmd.output();

        if (checkoutCode !== 0) {
          // Branch may already exist — try checkout without -b
          const switchCmd = new Deno.Command("git", {
            args: ["checkout", branch_name],
            cwd: Deno.cwd(),
            stdout: "piped",
            stderr: "piped",
          });
          await switchCmd.output();
        }

        return new Response(
          JSON.stringify({ success: true, branch: branch_name, base: base_branch }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ─── Git Commit ──────────────────────────────────────────────
    if (req.method === "POST" && path === "/git-commit") {
      const body = await req.json();
      const { branch_name, files, commit_message, ewo_ref } = body;

      if (!branch_name || !commit_message) {
        return new Response(JSON.stringify({ error: "Missing branch_name or commit_message" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        // Stage specified files (or all if not provided)
        if (files && files.length > 0) {
          const addCmd = new Deno.Command("git", {
            args: ["add", ...files],
            cwd: Deno.cwd(),
            stdout: "piped",
            stderr: "piped",
          });
          await addCmd.output();
        } else {
          const addAllCmd = new Deno.Command("git", {
            args: ["add", "-A"],
            cwd: Deno.cwd(),
            stdout: "piped",
            stderr: "piped",
          });
          await addAllCmd.output();
        }

        // Commit with EWO attribution
        const commitCmd = new Deno.Command("git", {
          args: ["commit", "-m", commit_message],
          cwd: Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        });
        const { code, stdout, stderr } = await commitCmd.output();
        const output = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);

        if (code !== 0) {
          return new Response(JSON.stringify({ error: `Commit failed: ${output}` }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Get commit SHA
        const revCmd = new Deno.Command("git", {
          args: ["rev-parse", "HEAD"],
          cwd: Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        });
        const { stdout: revOut } = await revCmd.output();
        const commitSha = new TextDecoder().decode(revOut).trim();

        return new Response(
          JSON.stringify({ success: true, commit_sha: commitSha, branch: branch_name }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ─── Git Push ────────────────────────────────────────────────
    if (req.method === "POST" && path === "/git-push") {
      const body = await req.json();
      const { branch_name, remote, ewo_ref } = body;
      const remoteUrl = remote || "origin";

      try {
        const pushCmd = new Deno.Command("git", {
          args: ["push", "-u", remoteUrl, branch_name],
          cwd: Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        });
        const { code, stdout, stderr } = await pushCmd.output();
        const output = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);

        if (code !== 0) {
          return new Response(JSON.stringify({ error: `Push failed: ${output}` }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Get remote URL
        const remoteUrlCmd = new Deno.Command("git", {
          args: ["remote", "get-url", remoteUrl],
          cwd: Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        });
        const { stdout: remoteOut } = await remoteUrlCmd.output();
        const remoteUrlValue = new TextDecoder().decode(remoteOut).trim();

        return new Response(
          JSON.stringify({ success: true, branch: branch_name, remote_url: remoteUrlValue }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ─── Git Rollback ─────────────────────────────────────────────
    if (req.method === "POST" && path === "/git-rollback") {
      const body = await req.json();
      const { branch_name, base_branch, ewo_ref } = body;

      try {
        // Reset to base branch
        const resetCmd = new Deno.Command("git", {
          args: ["reset", "--hard", base_branch],
          cwd: Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        });
        const { code, stdout, stderr } = await resetCmd.output();
        const output = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);

        if (code !== 0) {
          return new Response(JSON.stringify({ error: `Rollback failed: ${output}` }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const revCmd = new Deno.Command("git", {
          args: ["rev-parse", "HEAD"],
          cwd: Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        });
        const { stdout: revOut } = await revCmd.output();
        const resetTo = new TextDecoder().decode(revOut).trim();

        return new Response(
          JSON.stringify({ success: true, reset_to: resetTo, branch: branch_name }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ─── Git Delete Branch ───────────────────────────────────────
    if (req.method === "POST" && path === "/git-delete-branch") {
      const body = await req.json();
      const { branch_name, ewo_ref } = body;

      try {
        // Switch to base branch first
        const checkoutCmd = new Deno.Command("git", {
          args: ["checkout", "main"],
          cwd: Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        });
        await checkoutCmd.output();

        // Delete the branch
        const deleteCmd = new Deno.Command("git", {
          args: ["branch", "-D", branch_name],
          cwd: Deno.cwd(),
          stdout: "piped",
          stderr: "piped",
        });
        const { code, stdout, stderr } = await deleteCmd.output();
        const output = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);

        return new Response(
          JSON.stringify({ success: true, branch: branch_name, output }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "Unknown endpoint" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
