import { createClient } from "jsr:@supabase/supabase-js@2";
import { getOrganisationEmailProfile } from "../_shared/organisation-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

async function hashCode(code: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(code);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: { user }, error: userError } = await anonClient.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: profile } = await serviceClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (!profile || profile.role !== "admin") {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Invalidate all previous unused codes for this user
    await serviceClient
      .from("admin_otp_codes")
      .update({ used: true })
      .eq("user_id", user.id)
      .eq("used", false);

    // Generate 6-digit OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = await hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await serviceClient.from("admin_otp_codes").insert({
      user_id: user.id,
      code_hash: codeHash,
      expires_at: expiresAt,
    });

    // Fetch branding + email key
    // Issue #40: the user's own RTO branding; the email provider key is platform configuration.
    const { data: membership } = await serviceClient
      .from("organisation_memberships").select("organisation_id")
      .eq("user_id", user.id).eq("status", "active").maybeSingle();
    const [organisationProfile, { data: settingsData }] = await Promise.all([
      getOrganisationEmailProfile(membership?.organisation_id, serviceClient),
      serviceClient.from("settings").select("key, value").in("key", ["RESEND_API_KEY"]),
    ]);

    const settings: Record<string, any> = {};
    settingsData?.forEach((s: any) => { settings[s.key] = s.value; });

    const orgName: string = organisationProfile.branding.name || "LLND Automate";
    const RESEND_API_KEY: string | undefined =
      Deno.env.get("RESEND_API_KEY") ||
      (typeof settings["RESEND_API_KEY"] === "string" ? settings["RESEND_API_KEY"] : undefined);

    let emailSent = false;

    if (RESEND_API_KEY && user.email) {
      const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#1e40af;padding:32px 40px;">
      <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">${orgName}</h1>
      <p style="margin:8px 0 0;color:#bfdbfe;font-size:14px;">Admin Portal — Verification Code</p>
    </div>
    <div style="padding:40px;">
      <h2 style="margin:0 0 8px;color:#0f172a;font-size:20px;font-weight:600;">Your sign-in code</h2>
      <p style="margin:0 0 32px;color:#475569;font-size:15px;line-height:1.6;">Use the code below to complete your sign in. It expires in <strong>10 minutes</strong>.</p>
      <div style="background:#f1f5f9;border:2px dashed #cbd5e1;border-radius:12px;padding:24px;text-align:center;margin:0 0 32px;">
        <span style="font-size:40px;font-weight:800;letter-spacing:12px;color:#0f172a;font-family:monospace;">${code}</span>
      </div>
      <p style="margin:0;color:#94a3b8;font-size:13px;line-height:1.6;">If you didn't request this code, you can safely ignore this email. Someone may have entered your email address by mistake.</p>
    </div>
    <div style="padding:20px 40px;background:#f8fafc;border-top:1px solid #e2e8f0;">
      <p style="margin:0;color:#94a3b8;font-size:12px;">This is an automated message from ${orgName}. Do not reply.</p>
    </div>
  </div>
</body>
</html>`;

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${orgName} <onboarding@resend.dev>`,
          to: [user.email],
          subject: `${code} — your ${orgName} verification code`,
          html,
        }),
      });

      emailSent = res.ok;
    }

    return new Response(
      JSON.stringify({
        success: true,
        email_sent: emailSent,
        // Only expose the code when email is not configured (development fallback)
        ...((!RESEND_API_KEY) && { dev_code: code }),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (_err) {
    return new Response(
      JSON.stringify({ error: "An internal error occurred" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
