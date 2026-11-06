// Quilliam — one Cloudflare Worker that serves the app, takes Stripe payments,
// tracks letter credits and hosts share links for sealed letters.
//
// Bindings (Worker settings → Bindings):
//   DB       D1 database  "quilliam"
//   LETTERS  KV namespace "quilliam-letters"
// Secrets (Worker settings → Variables and Secrets, type "Secret"):
//   STRIPE_SECRET_KEY      sk_test_... while testing, sk_live_... when you launch
//   STRIPE_WEBHOOK_SECRET  whsec_... from the Stripe webhook you create

const PLANS = {
  pack:   { name: "Quilliam Holiday Pack (10 letters)", amount: 499, credits: 10 },
  season: { name: "Quilliam Season Pass (unlimited letters until Jan 1)", amount: 999, season: true },
};
const SEASON_END = "2027-01-01T05:00:00.000Z"; // midnight New York time, Jan 1 2027
const FREE_LETTERS = 1;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const APP_HTML = __APP_HTML__;
const LANDING_HTML = __LANDING_HTML__;

export default {
  async fetch(req, env) {
    try { return await route(req, env); }
    catch (e) { console.error(e && e.stack || e); return json({ error: "server_error" }, 500); }
  },
};

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname;
  if (req.method === "GET" && (p === "/" || p === "/index.html")) return page(LANDING_HTML);
  if (req.method === "GET" && (p === "/write" || p === "/write/")) return page(APP_HTML);
  if (req.method === "GET" && p.startsWith("/l/")) return letterPage(p.slice(3), url, env);
  if (req.method === "GET" && p.startsWith("/img/")) return letterImage(p.slice(5), env);
  if (req.method === "GET" && p === "/api/health")
    return json({ ok: true, db: !!env.DB, letters: !!env.LETTERS, stripe: !!env.STRIPE_SECRET_KEY, webhook: !!env.STRIPE_WEBHOOK_SECRET,
                  stripe_mode: env.STRIPE_SECRET_KEY ? (env.STRIPE_SECRET_KEY.startsWith("sk_live") ? "live" : "test") : null });
  if (req.method === "POST") {
    if (p === "/api/stripe-webhook") return webhook(req, env);
    const body = await readJson(req);
    if (body === null) return json({ error: "bad_request" }, 400);
    if (p === "/api/me") return me(body, env);
    if (p === "/api/checkout") return checkout(body, url, env);
    if (p === "/api/confirm") return confirm(body, env);
    if (p === "/api/seal") return seal(body, url, env);
    if (p === "/api/mail-request") return mailRequest(body, env);
    if (p === "/api/business-lead") return businessLead(body, env);
  }
  return new Response("Not found", { status: 404 });
}

/* ---------- accounts ---------- */
const TOKEN_RE = /^[a-f0-9]{48}$/;
function randomHex(bytes) { const a = crypto.getRandomValues(new Uint8Array(bytes)); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); }
function randomId() { const a = crypto.getRandomValues(new Uint8Array(12)); return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

async function account(env, token) {
  if (!token || !TOKEN_RE.test(token)) return null;
  const row = await env.DB.prepare("SELECT token, credits, season_until FROM buyers WHERE token = ?").bind(token).first();
  if (!row) return null;
  return { token: row.token, credits: row.credits, season: !!row.season_until && row.season_until > new Date().toISOString(), season_until: row.season_until };
}

async function me(body, env) {
  const existing = await account(env, body.token);
  if (existing) return json(existing);
  const token = randomHex(24);
  await env.DB.prepare("INSERT INTO buyers (token, credits) VALUES (?, ?)").bind(token, FREE_LETTERS).run();
  return json(await account(env, token));
}

/* ---------- Stripe ---------- */
async function stripe(env, method, path, form) {
  const r = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: form ? form.toString() : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error("stripe " + r.status + " " + (j.error && j.error.message)); e.stripe = j; throw e; }
  return j;
}

async function checkout(body, url, env) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "stripe_not_configured" }, 503);
  const plan = PLANS[body.plan];
  if (!plan) return json({ error: "unknown_plan" }, 400);
  const acct = await account(env, body.token);
  if (!acct) return json({ error: "unknown_buyer" }, 400);
  const f = new URLSearchParams();
  f.set("mode", "payment");
  f.set("line_items[0][quantity]", "1");
  f.set("line_items[0][price_data][currency]", "usd");
  f.set("line_items[0][price_data][unit_amount]", String(plan.amount));
  f.set("line_items[0][price_data][product_data][name]", plan.name);
  f.set("success_url", url.origin + "/write?paid={CHECKOUT_SESSION_ID}");
  f.set("cancel_url", url.origin + "/write?canceled=1");
  f.set("client_reference_id", acct.token);
  f.set("metadata[token]", acct.token);
  f.set("metadata[plan]", body.plan);
  f.set("allow_promotion_codes", "true");
  const session = await stripe(env, "POST", "/checkout/sessions", f);
  return json({ url: session.url });
}

// Records a paid Checkout Session once, however many times Stripe or the browser reports it.
async function grant(env, session) {
  if (!session || session.payment_status !== "paid") return false;
  const token = session.metadata && session.metadata.token;
  const planKey = session.metadata && session.metadata.plan;
  const plan = PLANS[planKey];
  if (!plan || !TOKEN_RE.test(token || "")) return false;
  const email = session.customer_details && session.customer_details.email || null;
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO purchases (session_id, token, plan, amount_cents, email) VALUES (?, ?, ?, ?, ?)")
    .bind(session.id, token, planKey, session.amount_total ?? plan.amount, email).run();
  if (!ins.meta || ins.meta.changes !== 1) return true; // already granted
  if (plan.season) await env.DB.prepare("UPDATE buyers SET season_until = ? WHERE token = ?").bind(SEASON_END, token).run();
  else await env.DB.prepare("UPDATE buyers SET credits = credits + ? WHERE token = ?").bind(plan.credits, token).run();
  return true;
}

async function confirm(body, env) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "stripe_not_configured" }, 503);
  const acct = await account(env, body.token);
  if (!acct || typeof body.session_id !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(body.session_id)) return json({ error: "bad_request" }, 400);
  const session = await stripe(env, "GET", "/checkout/sessions/" + body.session_id);
  if (!session.metadata || session.metadata.token !== acct.token) return json({ error: "not_yours" }, 403);
  if (session.payment_status !== "paid") return json({ error: "not_paid" }, 409);
  await grant(env, session);
  return json({ plan: session.metadata.plan, account: await account(env, acct.token) });
}

async function webhook(req, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "webhook_not_configured" }, 503);
  const raw = await req.text();
  const ok = await verifyStripeSignature(raw, req.headers.get("stripe-signature") || "", env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return json({ error: "bad_signature" }, 400);
  const event = JSON.parse(raw);
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    await grant(env, event.data.object);
  }
  return json({ received: true });
}

async function verifyStripeSignature(payload, header, secret) {
  const parts = Object.create(null);
  const v1 = [];
  for (const kv of header.split(",")) {
    const i = kv.indexOf("="); if (i < 0) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (k === "v1") v1.push(v); else parts[k] = v;
  }
  const t = Number(parts.t);
  if (!t || !v1.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + payload)));
  const expected = [...sig].map(b => b.toString(16).padStart(2, "0")).join("");
  return v1.some(s => timingSafeEqual(s, expected));
}
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

/* ---------- letters ---------- */
async function seal(body, url, env) {
  const acct = await account(env, body.token);
  if (!acct) return json({ error: "unknown_buyer" }, 400);
  if (!acct.season && acct.credits < 1) return json({ error: "no_credits", account: acct }, 402);
  const m = typeof body.image === "string" && body.image.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return json({ error: "bad_image" }, 400);
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  if (bytes.length > MAX_IMAGE_BYTES) return json({ error: "too_large" }, 413);

  if (!acct.season) {
    const spent = await env.DB.prepare("UPDATE buyers SET credits = credits - 1 WHERE token = ? AND credits > 0").bind(acct.token).run();
    if (!spent.meta || spent.meta.changes !== 1) return json({ error: "no_credits", account: await account(env, acct.token) }, 402);
  }
  const id = randomId();
  const meta = body.meta || {};
  const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  try {
    await env.LETTERS.put("img:" + id, bytes, { metadata: { type: m[1] } });
    await env.DB.prepare("INSERT INTO letters (id, token, to_name, from_name, paper, layout, certified, strokes, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, acct.token, clip(meta.to, 40), clip(meta.from, 40), clip(meta.paper, 40), clip(meta.layout, 20),
            meta.certified ? 1 : 0, Number(meta.strokes) || 0, Number(meta.words) || 0).run();
  } catch (e) {
    if (!acct.season) await env.DB.prepare("UPDATE buyers SET credits = credits + 1 WHERE token = ?").bind(acct.token).run();
    throw e;
  }
  return json({ id, url: url.origin + "/l/" + id, account: await account(env, acct.token) });
}

async function letterImage(id, env) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return new Response("Not found", { status: 404 });
  const { value, metadata } = await env.LETTERS.getWithMetadata("img:" + id, { type: "arrayBuffer" });
  if (!value) return new Response("Not found", { status: 404 });
  return new Response(value, { headers: { "Content-Type": (metadata && metadata.type) || "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
}

async function letterPage(id, url, env) {
  const row = /^[A-Za-z0-9_-]{16}$/.test(id) ? await env.DB.prepare("SELECT * FROM letters WHERE id = ?").bind(id).first() : null;
  if (!row) return page(shell("Letter not found", `<main class="wrap"><h1>This letter isn’t here</h1><p>The link may be mistyped. <a href="/write">Write a letter of your own</a>.</p></main>`, ""), 404);
  const from = esc(row.from_name || "Someone");
  const to = esc(row.to_name || "you");
  const img = url.origin + "/img/" + row.id;
  const title = `${from} wrote ${to} a letter`;
  const og = `<meta property="og:title" content="${title}"><meta property="og:description" content="Handwritten on Quilliam${row.certified ? ", certified human-written" : ""}."><meta property="og:image" content="${img}"><meta name="twitter:card" content="summary_large_image">`;
  const body = `<main class="wrap">
    <p class="eyebrow">A letter for ${to}</p>
    <h1>${from} wrote you a letter</h1>
    ${row.certified ? `<p class="cert">✓ Quilliam-certified: written by a human hand</p>` : ""}
    <img class="letter" src="/img/${row.id}" alt="Handwritten letter from ${from} to ${to}">
    <div class="row">
      <a class="btn primary" href="/write?to=${encodeURIComponent(row.from_name || "")}">Write ${from} one back</a>
      <a class="btn" href="/img/${row.id}" download="letter-from-${(row.from_name || "a-friend").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.jpg">Save the letter</a>
    </div>
    <p class="fine">Your first letter on Quilliam is free.</p>
  </main>`;
  return page(shell(title, body, og));
}

/* ---------- mailed-letter interest ---------- */
async function mailRequest(body, env) {
  const email = typeof body.email === "string" ? body.email.trim().slice(0, 120) : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "bad_email" }, 400);
  const clip = (v) => (typeof v === "string" ? v.slice(0, 40) : null);
  await env.DB.prepare("INSERT INTO mail_requests (email, price, occasion, paper, layout) VALUES (?, ?, ?, ?, ?)")
    .bind(email, clip(body.price), clip(body.occasion), clip(body.paper), clip(body.layout)).run();
  return json({ ok: true });
}

/* ---------- business leads ---------- */
async function businessLead(body, env) {
  const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const name = clip(body.name, 80), company = clip(body.company, 100), email = clip(body.email, 120), size = clip(body.size, 40);
  if (!name || !company || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "bad_request" }, 400);
  await env.DB.prepare("INSERT INTO business_leads (name, company, email, size) VALUES (?, ?, ?, ?)").bind(name, company, email, size).run();
  return json({ ok: true });
}

/* ---------- helpers ---------- */
async function readJson(req) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 7 * 1024 * 1024) return null;
  try { const j = await req.json(); return j && typeof j === "object" ? j : null; } catch { return null; }
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
function page(html, status = 200) {
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" } });
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function shell(title, body, head) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>${head}
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@1,9..144,800&family=Manrope:wght@500;700&display=swap">
<style>
:root{color-scheme:dark}
body{margin:0;background:radial-gradient(1000px 500px at 30% -10%,#3a2a1c55,transparent 70%),#1a1512;color:#f1e7da;font:15px/1.5 Manrope,system-ui,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:28px max(16px,env(safe-area-inset-left)) 60px max(16px,env(safe-area-inset-right));display:grid;gap:14px}
.eyebrow{margin:0;font:12px "Courier New",monospace;letter-spacing:.2em;text-transform:uppercase;color:#e0a63a}
h1{margin:0;font:italic 800 clamp(30px,6vw,46px)/1.05 Fraunces,Georgia,serif;text-wrap:balance}
.cert{margin:0;color:#8fe0b8;font-weight:700}
.letter{width:100%;height:auto;border-radius:8px;box-shadow:0 24px 50px #0009}
.row{display:flex;flex-wrap:wrap;gap:10px}
.btn{display:inline-block;border:1px solid #3a3029;background:#231c17;color:#f1e7da;border-radius:12px;padding:12px 18px;font-weight:700;text-decoration:none}
.btn.primary{background:linear-gradient(180deg,#b3341f,#8e2414);border-color:#b3341f;color:#fff3e8}
.fine{color:#a6978a;font-size:13px;margin:0} a{color:#e0a63a}
</style></head><body>${body}</body></html>`;
}
