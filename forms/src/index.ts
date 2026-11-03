const EMAIL_RE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]{2,}$/;
const HOURLY_LIMIT = 5;
const HONEYPOT = "website";

interface MailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

interface MailerService {
  send(message: {
    fromName: string;
    to: string;
    replyTo?: { email: string; name?: string };
    subject: string;
    text: string;
    html: string;
  }): Promise<MailResult>;
}

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  SITE_NAME: string;
  SITE_DOMAIN: string;
  RECIPIENT_EMAIL: string;
  TURNSTILE_SECRET?: string;
  DB: D1Database;
  MAILER: MailerService;
  BURST_LIMITER: RateLimiter;
}

interface ContactData {
  name: string;
  email: string;
  phone: string;
  company: string;
  message: string;
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function oneLine(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, max);
}

function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] as string
  );
}

function configuredOrigins(env: Env): string[] {
  return String(env.SITE_DOMAIN || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        return [new URL(value.includes("://") ? value : `https://${value}`).origin];
      } catch {
        return [];
      }
    });
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin" };
  if (origin && configuredOrigins(env).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("Content-Type") || "";
  if (type.includes("application/json")) {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  }
  if (
    type.includes("multipart/form-data") ||
    type.includes("application/x-www-form-urlencoded")
  ) {
    return Object.fromEntries(await request.formData());
  }
  throw new Error("unsupported content type");
}

function validate(body: Record<string, unknown>): {
  errors: Record<string, string>;
  data: ContactData;
} {
  const data = {
    name: oneLine(body.name, 101),
    email: oneLine(body.email, 255).toLowerCase(),
    phone: oneLine(body.phone, 41),
    company: oneLine(body.company, 121),
    message: String(body.message ?? "")
      .replace(/\r\n?/g, "\n")
      .trim()
  };
  const errors: Record<string, string> = {};

  if (!data.name) errors.name = "Name is required.";
  else if (data.name.length > 100) errors.name = "Name must be 100 characters or fewer.";
  if (!data.email) errors.email = "Email is required.";
  else if (data.email.length > 254 || !EMAIL_RE.test(data.email)) {
    errors.email = "Enter a valid email address.";
  }
  if (data.phone.length > 40) errors.phone = "Phone must be 40 characters or fewer.";
  if (data.company.length > 120) {
    errors.company = "Company must be 120 characters or fewer.";
  }
  if (data.message.length < 10) errors.message = "Message must be at least 10 characters.";
  else if (data.message.length > 5000) {
    errors.message = "Message must be 5000 characters or fewer.";
  }

  return { errors, data };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyTurnstile(token: unknown, ip: string, secret: string): Promise<boolean> {
  if (!token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", String(token));
  if (ip) form.append("remoteip", ip);
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form }
  );
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}

function renderEmail(data: ContactData): { text: string; html: string } {
  const rows = [
    ["Name", data.name],
    ["Email", data.email],
    ...(data.phone ? [["Phone", data.phone]] : []),
    ...(data.company ? [["Company", data.company]] : [])
  ];
  const text = `${rows.map(([key, value]) => `${key}: ${value}`).join("\n")}\n\nMessage:\n${data.message}\n`;
  const html = `<table cellpadding="4" style="font-family:sans-serif;font-size:14px">${rows
    .map(
      ([key, value]) =>
        `<tr><td><strong>${escapeHtml(key)}</strong></td><td>${escapeHtml(value)}</td></tr>`
    )
    .join("")}</table><p style="font-family:sans-serif;font-size:14px"><strong>Message</strong></p><p style="font-family:sans-serif;font-size:14px;white-space:pre-wrap">${escapeHtml(data.message)}</p>`;
  return { text, html };
}

async function handleContact(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256(`${configuredOrigins(env)[0] || env.SITE_DOMAIN}:${ip}`);
  const burst = await env.BURST_LIMITER.limit({ key: ipHash });
  if (!burst.success) {
    return json({ ok: false, error: "Too many requests. Try again in a minute." }, 429, cors);
  }

  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch {
    return json({ ok: false, error: "Invalid request body." }, 400, cors);
  }

  if (String(body[HONEYPOT] ?? "").trim()) {
    return json({ ok: false, error: "Submission rejected." }, 400, cors);
  }

  const { errors, data } = validate(body);
  if (Object.keys(errors).length) {
    return json(
      { ok: false, error: "Please fix the highlighted fields.", fields: errors },
      400,
      cors
    );
  }

  if (env.TURNSTILE_SECRET) {
    const passed = await verifyTurnstile(
      body["cf-turnstile-response"],
      ip,
      env.TURNSTILE_SECRET
    );
    if (!passed) {
      return json({ ok: false, error: "Verification failed. Please try again." }, 400, cors);
    }
  }

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM form_submissions WHERE ip_hash = ? AND created_at > ?"
  )
    .bind(ipHash, since)
    .first<number>("n");
  if (Number(recent || 0) >= HOURLY_LIMIT) {
    return json({ ok: false, error: "Too many submissions. Try again later." }, 429, cors);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO form_submissions
      (id, form_id, recipient, name, email, phone, company, message, fields_json, ip_hash, user_agent, status, created_at)
     VALUES (?, 'contact', 'default', ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`
  )
    .bind(
      id,
      data.name,
      data.email,
      data.phone || null,
      data.company || null,
      data.message,
      JSON.stringify(data),
      ipHash,
      oneLine(request.headers.get("User-Agent"), 300) || null,
      now
    )
    .run();

  const email = renderEmail(data);
  const result = await env.MAILER.send({
    fromName: env.SITE_NAME,
    to: env.RECIPIENT_EMAIL,
    replyTo: { email: data.email, name: data.name },
    subject: `New ${env.SITE_NAME} form submission: ${data.name}`,
    ...email
  });
  const status = result.ok ? "sent" : "failed";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mail_log
        (id, submission_id, template, to_addr, status, provider_id, error, created_at)
       VALUES (?, ?, 'contact-notify', ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      id,
      env.RECIPIENT_EMAIL,
      status,
      result.id || null,
      result.error || null,
      new Date().toISOString()
    ),
    env.DB.prepare("UPDATE form_submissions SET status = ? WHERE id = ?").bind(
      result.ok ? "sent" : "mail_failed",
      id
    )
  ]);

  if (!result.ok) {
    console.error("mail failed", id, result.error);
    return json(
      {
        ok: false,
        error: "Your message was saved but could not be delivered. Please try again later.",
        id
      },
      502,
      cors
    );
  }
  return json({ ok: true, id }, 200, cors);
}

function landingPage(request: Request, env: Env): Response {
  const action = `${new URL(request.url).origin}/api/contact`;
  const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(env.SITE_NAME)} form endpoint</title>
  <style>
    :root { color-scheme: light; font: 16px/1.5 system-ui, sans-serif; color: #18212f; background: #f4f7fb; }
    body { margin: 0; padding: 32px 20px; }
    main { max-width: 720px; margin: 0 auto; background: white; padding: clamp(24px, 5vw, 48px); border-radius: 18px; box-shadow: 0 12px 40px #24324a18; }
    h1 { margin-top: 0; line-height: 1.15; }
    .status { display: inline-flex; gap: 8px; align-items: center; color: #176b3a; font-weight: 650; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #22a35a; }
    .endpoint { display: flex; gap: 8px; margin: 12px 0 28px; }
    code { flex: 1; overflow-wrap: anywhere; padding: 12px; background: #eef2f7; border-radius: 8px; }
    button { border: 0; border-radius: 8px; padding: 10px 16px; background: #1f5eff; color: white; font: inherit; font-weight: 650; cursor: pointer; }
    li { margin: 10px 0; }
  </style>
</head>
<body>
  <main>
    <div class="status"><span class="dot"></span>Form service is healthy</div>
    <h1>${escapeHtml(env.SITE_NAME)} is ready</h1>
    <p>Use this exact URL as your Etch form action:</p>
    <div class="endpoint"><code id="action">${escapeHtml(action)}</code><button id="copy">Copy</button></div>
    <h2>Connect your Etch form</h2>
    <ol>
      <li>Open the form in Etch and set its action URL to the address above.</li>
      <li>Set the method to <strong>POST</strong>.</li>
      <li>Name the required fields <code>name</code>, <code>email</code>, and <code>message</code>. You can also use <code>phone</code> and <code>company</code>.</li>
      <li>Add a hidden field named <code>website</code> and leave its value empty. This catches simple spam bots.</li>
      <li>Publish the site and send one test message.</li>
    </ol>
    <p>The health check is available at <a href="/health"><code>/health</code></a>.</p>
  </main>
  <script>
    document.querySelector("#copy").addEventListener("click", async (event) => {
      await navigator.clipboard.writeText(document.querySelector("#action").textContent);
      event.currentTarget.textContent = "Copied";
    });
  </script>
</body>
</html>`;
  return new Response(page, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return landingPage(request, env);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "forms", site: env.SITE_NAME });
    }

    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);
    if (url.pathname !== "/api/contact") {
      return json({ ok: false, error: "Not found." }, 404, cors);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: cors["Access-Control-Allow-Origin"] ? 204 : 403,
        headers: cors
      });
    }
    if (request.method !== "POST") {
      return json(
        { ok: false, error: "Method not allowed." },
        405,
        { ...cors, Allow: "POST, OPTIONS" }
      );
    }
    if (!origin || !configuredOrigins(env).includes(origin)) {
      return json({ ok: false, error: "Origin not allowed." }, 403, cors);
    }

    try {
      return await handleContact(request, env, cors);
    } catch (error) {
      console.error("contact error", error instanceof Error ? error.message : error);
      return json(
        { ok: false, error: "Something went wrong. Please try again." },
        500,
        cors
      );
    }
  }
} satisfies ExportedHandler<Env>;
