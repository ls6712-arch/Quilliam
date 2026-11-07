// Quilliam — one Cloudflare Worker that serves the app, takes Stripe payments,
// tracks letter credits and hosts share links for sealed letters.
//
// Bindings (Worker settings → Bindings):
//   DB       D1 database  "quilliam"
//   LETTERS  KV namespace "quilliam-letters"
// Secrets (Worker settings → Variables and Secrets, type "Secret"):
//   STRIPE_SECRET_KEY      sk_test_... while testing, sk_live_... when you launch
//   STRIPE_WEBHOOK_SECRET  whsec_... from the Stripe webhook you create
//   ANTHROPIC_API_KEY      optional, turns on Quilliam's AI comments
//   RESEND_API_KEY         optional, turns on email sign-in links (needs MAIL_FROM too)
// Variables (plain text):
//   MAIL_FROM              e.g. "Quilliam <hello@yourdomain.com>" on a domain verified in Resend
//   GOOGLE_CLIENT_ID       turns on "Continue with Google" (with GOOGLE_CLIENT_SECRET as a secret)

const PLANS = {
  one:    { name: "Quilliam letter (1 letter)", amount: 199, credits: 1 },
  pack:   { name: "Quilliam Holiday Pack (10 letters)", amount: 499, credits: 10 },
  season: { name: "Quilliam Season Pass (unlimited letters until Jan 1)", amount: 999, season: true },
};
const SEASON_END = "2027-01-01T05:00:00.000Z"; // midnight New York time, Jan 1 2027
const FREE_LETTERS = 1;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const NEW_ACCOUNTS_PER_IP_PER_DAY = 10; // generous: offices, campuses and phone carriers share addresses

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
  if (req.method === "GET" && p.startsWith("/img/")) return letterImage(p.slice(5), url, env);
  if (req.method === "GET" && p.startsWith("/ink/")) return letterInk(p.slice(5), url, env);
  if (req.method === "GET" && LEGAL[p.replace(/\/$/, "")]) return legalPage(p.replace(/\/$/, ""), url);
  if (req.method === "GET" && p === "/auth/google") return googleStart(req, url, env);
  if (req.method === "GET" && p === "/auth/google/callback") return googleCallback(req, url, env);
  if (req.method === "GET" && p === "/api/health")
    return json({ ok: true, db: !!env.DB, letters: !!env.LETTERS, stripe: !!env.STRIPE_SECRET_KEY, webhook: !!env.STRIPE_WEBHOOK_SECRET, ai: !!env.ANTHROPIC_API_KEY, email: !!(env.RESEND_API_KEY && env.MAIL_FROM), google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
                  stripe_mode: env.STRIPE_SECRET_KEY ? (env.STRIPE_SECRET_KEY.startsWith("sk_live") ? "live" : "test") : null });
  if (req.method === "POST") {
    if (p === "/api/stripe-webhook") return webhook(req, env);
    const body = await readJson(req);
    if (body === null) return json({ error: "bad_request" }, 400);
    if (p === "/api/me") return me(body, env, req);
    if (p === "/api/letters") return myLetters(body, url, env);
    if (p === "/api/redeem") return redeem(body, env);
    if (p === "/api/signin/start") return signinStart(body, url, env);
    if (p === "/api/signin/finish") return signinFinish(body, env);
    if (p === "/api/contact") return contact(body, env);
    if (p === "/api/checkout") return checkout(body, url, env);
    if (p === "/api/confirm") return confirm(body, env);
    if (p === "/api/seal") return seal(body, url, env);
    if (p === "/api/mail-request") return mailRequest(body, env);
    if (p === "/api/business-lead") return businessLead(body, env);
    if (p === "/api/quilliam") return quilliam(body, env);
  }
  return new Response("Not found", { status: 404 });
}

/* ---------- accounts ---------- */
const TOKEN_RE = /^[a-f0-9]{48}$/;
function randomHex(bytes) { const a = crypto.getRandomValues(new Uint8Array(bytes)); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); }
function randomId() { const a = crypto.getRandomValues(new Uint8Array(12)); return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

async function account(env, token) {
  if (!token || !TOKEN_RE.test(token)) return null;
  const row = await env.DB.prepare("SELECT token, credits, season_until, email FROM buyers WHERE token = ?").bind(token).first();
  if (!row) return null;
  return { token: row.token, credits: row.credits, season: !!row.season_until && row.season_until > new Date().toISOString(), season_until: row.season_until, email: row.email || null };
}

async function me(body, env, req) {
  const existing = await account(env, body.token);
  if (existing) return json(existing);
  // The free letter is limited per network so it can't be farmed by clearing the browser.
  const ip = req.headers.get("cf-connecting-ip") || "local";
  const day = new Date().toISOString().slice(0, 10);
  const seen = await env.DB.prepare("INSERT INTO signup_ips (ip, day, n) VALUES (?, ?, 1) ON CONFLICT(ip, day) DO UPDATE SET n = n + 1 RETURNING n").bind(ip, day).first();
  const free = seen && seen.n > NEW_ACCOUNTS_PER_IP_PER_DAY ? 0 : FREE_LETTERS;
  const token = randomHex(24);
  await env.DB.prepare("INSERT INTO buyers (token, credits) VALUES (?, ?)").bind(token, free).run();
  return json(await account(env, token));
}

/* ---------- my letters ---------- */
async function myLetters(body, url, env) {
  const acct = await account(env, body.token);
  if (!acct) return json({ error: "unknown_buyer" }, 400);
  const { results } = await env.DB.prepare("SELECT id, to_name, created_at, unlock_at, lock_hash, certified FROM letters WHERE token = ? ORDER BY created_at DESC LIMIT 100").bind(acct.token).all();
  return json({ letters: results.map(r => ({ id: r.id, url: url.origin + "/l/" + r.id, to: r.to_name || "", created_at: r.created_at, unlock_at: r.unlock_at, locked: !!r.lock_hash, certified: !!r.certified })) });
}

/* ---------- gift, promo and company codes ---------- */
// Create codes in D1, e.g.:
//   INSERT INTO codes (code, credits, max_uses, expires_at, note) VALUES ('FRIENDS5', 5, 100, '2026-12-31T23:59:59Z', 'launch');
//   INSERT INTO codes (code, season, max_uses, note) VALUES ('ACME-TEAM', 1, 40, 'Acme Inc. 40 seats');
async function redeem(body, env) {
  const acct = await account(env, body.token);
  if (!acct) return json({ error: "unknown_buyer" }, 400);
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase().replace(/\s+/g, "").slice(0, 40) : "";
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return json({ error: "unknown_code" }, 404);
  const c = await env.DB.prepare("SELECT * FROM codes WHERE code = ?").bind(code).first();
  if (!c) return json({ error: "unknown_code" }, 404);
  if (c.expires_at && c.expires_at < new Date().toISOString()) return json({ error: "expired" }, 410);
  const taken = await env.DB.prepare("UPDATE codes SET uses = uses + 1 WHERE code = ? AND (max_uses IS NULL OR uses < max_uses)").bind(code).run();
  if (!taken.meta || taken.meta.changes !== 1) return json({ error: "used_up" }, 410);
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO redemptions (code, token) VALUES (?, ?)").bind(code, acct.token).run();
  if (!ins.meta || ins.meta.changes !== 1) { await env.DB.prepare("UPDATE codes SET uses = uses - 1 WHERE code = ?").bind(code).run(); return json({ error: "already" }, 409); }
  if (c.season) await env.DB.prepare("UPDATE buyers SET season_until = ? WHERE token = ?").bind(SEASON_END, acct.token).run();
  if (c.credits) await env.DB.prepare("UPDATE buyers SET credits = credits + ? WHERE token = ?").bind(c.credits, acct.token).run();
  const parts = [c.credits ? `${c.credits} letter${c.credits === 1 ? "" : "s"}` : "", c.season ? "unlimited letters until Jan 1" : ""].filter(Boolean);
  return json({ message: "Code applied: " + (parts.join(" and ") || "enjoy") + ".", account: await account(env, acct.token) });
}

/* ---------- email sign-in (magic link) ---------- */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
async function signinStart(body, url, env) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
  if (!EMAIL_RE.test(email)) return json({ error: "bad_email" }, 400);
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return json({ error: "email_not_configured" }, 503);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM signin_codes WHERE email = ? AND created_at > datetime('now', '-1 hour')").bind(email).first();
  if (recent && recent.n >= 5) return json({ error: "rate_limited" }, 429);
  const code = randomHex(24);
  await env.DB.prepare("INSERT INTO signin_codes (code_hash, email, expires_at) VALUES (?, ?, ?)").bind(await sha256hex(code), email, new Date(Date.now() + 30 * 6e4).toISOString()).run();
  const link = url.origin + "/write?signin=" + code;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject: "Your Quilliam sign-in link",
      text: `Tap to sign in to Quilliam:\n${link}\n\nThe link works once, for 30 minutes. If you didn't ask for it, ignore this email.`,
      html: `<div style="font-family:Georgia,serif;font-size:16px;color:#2b2420"><p>Hoo! Here is your sign-in link for Quilliam.</p><p><a href="${link}" style="display:inline-block;background:#b3341f;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none">Sign in to Quilliam</a></p><p style="color:#776">It works once, for 30 minutes. If you didn't ask for it, ignore this email.</p></div>` }),
  });
  if (!r.ok) { console.error("resend", r.status, await r.text().catch(() => "")); return json({ error: "email_failed" }, 502); }
  return json({ ok: true });
}

/* ---------- Continue with Google ----------
   Standard OAuth code flow. The callback turns the verified Google email into the same
   one-time sign-in code the email link uses, so /api/signin/finish does the account
   linking (and merging of this browser's letters) in one place. */
const GOOGLE_STATE_COOKIE = "q_gstate";
function googleRedirectUri(url) { return url.origin + "/auth/google/callback"; }
function back(url, reason) { return Response.redirect(url.origin + "/write?signin_error=" + reason, 302); }
async function googleStart(req, url, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return back(url, "google_off");
  const state = randomHex(16);
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: googleRedirectUri(url), response_type: "code",
    scope: "openid email", state, prompt: "select_account" });
  return new Response(null, { status: 302, headers: {
    Location: "https://accounts.google.com/o/oauth2/v2/auth?" + q,
    "Set-Cookie": `${GOOGLE_STATE_COOKIE}=${state}; Path=/auth/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    "Cache-Control": "no-store" } });
}
async function googleCallback(req, url, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return back(url, "google_off");
  const cookie = (req.headers.get("Cookie") || "").split(/;\s*/).find(c => c.startsWith(GOOGLE_STATE_COOKIE + "="));
  const state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
  const clear = `${GOOGLE_STATE_COOKIE}=; Path=/auth/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  const fail = (r) => new Response(null, { status: 302, headers: { Location: url.origin + "/write?signin_error=" + r, "Set-Cookie": clear } });
  if (url.searchParams.get("error")) return fail("google_cancelled");
  if (!cookie || !state || !timingSafeEqual(cookie.split("=")[1], state) || !code) return fail("google_state");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: googleRedirectUri(url), grant_type: "authorization_code" }) });
  if (!r.ok) { console.error("google token", r.status, await r.text().catch(() => "")); return fail("google_failed"); }
  const tok = await r.json();
  // The ID token came straight from Google's token endpoint over TLS, so its claims can be read without re-checking the signature.
  let claims = null;
  try { const part = tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); claims = JSON.parse(atob(part + "===".slice((part.length + 3) % 4))); } catch {}
  const aud = claims && (Array.isArray(claims.aud) ? claims.aud : [claims.aud]);
  if (!claims || !aud.includes(env.GOOGLE_CLIENT_ID) || !/accounts\.google\.com$/.test(claims.iss || "") || claims.exp * 1000 < Date.now()
      || !claims.email || !(claims.email_verified === true || claims.email_verified === "true")) return fail("google_failed");
  const one = randomHex(24);
  await env.DB.prepare("INSERT INTO signin_codes (code_hash, email, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256hex(one), String(claims.email).toLowerCase(), new Date(Date.now() + 5 * 6e4).toISOString()).run();
  return new Response(null, { status: 302, headers: { Location: url.origin + "/write?signin=" + one, "Set-Cookie": clear, "Cache-Control": "no-store" } });
}

async function signinFinish(body, env) {
  const code = typeof body.code === "string" ? body.code : "";
  if (!/^[a-f0-9]{48}$/.test(code)) return json({ error: "bad_code" }, 400);
  const h = await sha256hex(code);
  const used = await env.DB.prepare("UPDATE signin_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND expires_at > ? RETURNING email").bind(h, new Date().toISOString()).first();
  if (!used) return json({ error: "expired" }, 410);
  const email = used.email;
  const here = await account(env, body.token);
  const owner = await env.DB.prepare("SELECT token FROM buyers WHERE email = ?").bind(email).first();
  if (!owner) {
    // First sign-in: this browser's account becomes the email's account.
    if (here && !here.email) { await env.DB.prepare("UPDATE buyers SET email = ? WHERE token = ?").bind(email, here.token).run(); return json({ email, account: await account(env, here.token) }); }
    const token = randomHex(24);
    await env.DB.prepare("INSERT INTO buyers (token, credits, email) VALUES (?, 0, ?)").bind(token, email).run();
    return json({ email, account: await account(env, token) });
  }
  if (here && here.token !== owner.token && !here.email) {
    // Bring this browser's letters along, plus any letters it paid for (not a second free letter).
    const paid = await env.DB.prepare("SELECT COUNT(*) AS n FROM purchases WHERE token = ?").bind(here.token).first();
    const coded = await env.DB.prepare("SELECT COUNT(*) AS n FROM redemptions WHERE token = ?").bind(here.token).first();
    const carry = (paid && paid.n) || (coded && coded.n) ? here.credits : 0;
    await env.DB.batch([
      env.DB.prepare("UPDATE letters SET token = ? WHERE token = ?").bind(owner.token, here.token),
      env.DB.prepare("UPDATE purchases SET token = ? WHERE token = ?").bind(owner.token, here.token),
      env.DB.prepare("UPDATE buyers SET credits = credits + ?, season_until = CASE WHEN ? > IFNULL(season_until, '') THEN ? ELSE season_until END WHERE token = ?")
        .bind(carry, here.season_until || "", here.season_until || null, owner.token),
      env.DB.prepare("UPDATE buyers SET credits = 0, season_until = NULL WHERE token = ?").bind(here.token),
    ]);
  }
  return json({ email, account: await account(env, owner.token) });
}

/* ---------- contact ---------- */
async function contact(body, env) {
  const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const name = clip(body.name, 80), email = clip(body.email, 120), topic = clip(body.topic, 40), message = clip(body.message, 4000);
  if (!EMAIL_RE.test(email) || message.length < 3) return json({ error: "bad_request" }, 400);
  await env.DB.prepare("INSERT INTO contact_messages (name, email, topic, message) VALUES (?, ?, ?, ?)").bind(name, email, topic, message).run();
  return json({ ok: true });
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
  const hex = (v) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);
  // Optional delivery date (up to a year ahead) and a playful secret question.
  let unlockAt = null;
  if (typeof meta.unlock_at === "string") { const t = Date.parse(meta.unlock_at); if (t && t > Date.now() && t < Date.now() + 366 * 864e5) unlockAt = new Date(t).toISOString(); }
  const lockQ = clip(typeof meta.lock_q === "string" ? meta.lock_q.trim() : null, 100) || null;
  const lockA = typeof meta.lock_a === "string" ? normAnswer(meta.lock_a).slice(0, 60) : "";
  const lockHash = lockQ && lockA ? await sha256hex(id + ":" + lockA) : null;
  const sealO = cleanSeal(meta.seal_o);
  // The server runs the handwriting check itself; the page's own opinion is ignored.
  const hand = meta.mode !== "type";
  const ink = hand && inkValid(meta.ink) ? meta.ink : null;
  const chk = hand ? analyzeInk(ink) : analyzeTyping(meta.typing);
  const check = { mode: hand ? "hand" : "type", verdict: chk.verdict, certified: chk.verdict === "human", reasons: chk.reasons.slice(0, 4), facts: chk.facts };
  try {
    await env.LETTERS.put("img:" + id, bytes, { metadata: { type: m[1] } });
    if (ink) await env.LETTERS.put("ink:" + id, JSON.stringify({ v: 1, w: ink.w, h: ink.h, r: Array.isArray(ink.r) ? ink.r.slice(0, 4).map(Number) : null, s: ink.s.map(st => [String(st[0]).slice(0, 12), /^#[0-9a-fA-F]{6}$/.test(st[1]) ? st[1] : "#2b2420", st[2]]) }));
    await env.DB.prepare("INSERT INTO letters (id, token, to_name, from_name, paper, layout, certified, strokes, words, unlock_at, lock_q, lock_hash, seal_c, seal_d, seal_g, seal_o, ink_report) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, acct.token, clip(meta.to, 40), clip(meta.from, 40), clip(meta.paper, 40), clip(meta.layout, 20),
            check.certified ? 1 : 0, Number(meta.strokes) || 0, Number(meta.words) || 0,
            unlockAt, lockHash ? lockQ : null, lockHash, hex(meta.seal_c), hex(meta.seal_d), clip(meta.seal_g, 2), sealO ? JSON.stringify(sealO) : null,
            JSON.stringify({ ...check, replay: !!ink })).run();
  } catch (e) {
    if (!acct.season) await env.DB.prepare("UPDATE buyers SET credits = credits + 1 WHERE token = ?").bind(acct.token).run();
    throw e;
  }
  return json({ id, url: url.origin + "/l/" + id, check, account: await account(env, acct.token) });
}

function cleanSeal(o) {
  if (!o || typeof o !== "object") return null;
  const pick = (v, set) => (typeof v === "string" && Object.prototype.hasOwnProperty.call(set, v) ? v : null);
  const out = { shape: pick(o.shape, SEAL_SHAPES) || "classic", color: pick(o.color, WAX) || "crimson", emblem: pick(o.emblem, SEAL_EMBLEMS) || "heart",
    finish: pick(o.finish, SEAL_FINISHES) || "wax", letter: typeof o.letter === "string" ? o.letter.replace(/[^A-Za-z]/g, "").slice(0, 1).toUpperCase() : "" };
  return out;
}
function envelopeSeal(row) {
  let o = null; try { o = row.seal_o ? cleanSeal(JSON.parse(row.seal_o)) : null; } catch {}
  if (!o) o = { shape: "classic", color: "crimson", emblem: "heart", finish: "wax", letter: "" };
  return waxSeal(o);
}

function normAnswer(a) { return String(a || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
async function sha256hex(t) { const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))); return [...d].map(b => b.toString(16).padStart(2, "0")).join(""); }

async function letterGate(id, url, env) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return { res: new Response("Not found", { status: 404 }) };
  const row = await env.DB.prepare("SELECT unlock_at, lock_hash FROM letters WHERE id = ?").bind(id).first();
  if (!row) return { res: new Response("Not found", { status: 404 }) };
  if (row.unlock_at && row.unlock_at > new Date().toISOString()) return { res: new Response("This letter is still sealed", { status: 403 }) };
  if (row.lock_hash && !timingSafeEqual(url.searchParams.get("k") || "", row.lock_hash)) return { res: new Response("Answer the question to open this letter", { status: 403 }) };
  return { gated: !!(row.unlock_at || row.lock_hash) };
}
async function letterInk(id, url, env) {
  const g = await letterGate(id, url, env); if (g.res) return g.res;
  const v = await env.LETTERS.get("ink:" + id);
  if (!v) return new Response("Not found", { status: 404 });
  return new Response(v, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": g.gated ? "private, no-store" : "public, max-age=31536000, immutable" } });
}

async function letterImage(id, url, env) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return new Response("Not found", { status: 404 });
  const row = await env.DB.prepare("SELECT unlock_at, lock_hash FROM letters WHERE id = ?").bind(id).first();
  if (!row) return new Response("Not found", { status: 404 });
  const gated = !!(row.unlock_at || row.lock_hash);
  if (row.unlock_at && row.unlock_at > new Date().toISOString()) return new Response("This letter is still sealed", { status: 403 });
  if (row.lock_hash && !timingSafeEqual(url.searchParams.get("k") || "", row.lock_hash)) return new Response("Answer the question to open this letter", { status: 403 });
  const { value, metadata } = await env.LETTERS.getWithMetadata("img:" + id, { type: "arrayBuffer" });
  if (!value) return new Response("Not found", { status: 404 });
  return new Response(value, { headers: { "Content-Type": (metadata && metadata.type) || "image/jpeg", "Cache-Control": gated ? "private, no-store" : "public, max-age=31536000, immutable" } });
}

async function letterPage(id, url, env) {
  const row = /^[A-Za-z0-9_-]{16}$/.test(id) ? await env.DB.prepare("SELECT * FROM letters WHERE id = ?").bind(id).first() : null;
  if (!row) return page(shell("Letter not found", `<main class="wrap"><h1>This letter isn’t here</h1><p>The link may be mistyped. <a href="/write">Write a letter of your own</a>.</p></main>`, ""), 404);
  const from = esc(row.from_name || "Someone");
  const to = esc(row.to_name || "you");
  const title = `${from} wrote ${to} a letter`;
  const gated = !!(row.unlock_at || row.lock_hash);
  const og = `<meta property="og:title" content="${title}"><meta property="og:description" content="${gated ? "A sealed letter, handwritten on Quilliam." : "Handwritten on Quilliam" + (row.certified ? ", certified human-written." : ".")}">` +
    (gated ? "" : `<meta property="og:image" content="${url.origin}/img/${row.id}"><meta name="twitter:card" content="summary_large_image">`);
  let rep = null; try { rep = row.ink_report ? JSON.parse(row.ink_report) : null; } catch {}
  const data = { id: row.id, to: row.to_name || "", from: row.from_name || "", certified: !!row.certified, unlockAt: row.unlock_at || null,
    question: row.lock_hash ? row.lock_q : null, replay: !!(rep && rep.replay), check: rep ? { mode: rep.mode, verdict: rep.verdict, reasons: rep.reasons, facts: rep.facts } : null };
  const body = `<main class="wrap env-page">
    <p class="eyebrow" id="eyebrow">A letter for ${to}</p>
    <h1 id="headline">${from} sent you a letter</h1>
    <div class="stage" id="stage">
      <div class="envelope" id="envelope" role="button" tabindex="0" aria-label="Open the envelope">
        <div class="env-back"></div>
        <div class="env-letter" id="envLetter"><img id="letterImg" alt="Handwritten letter from ${from} to ${to}"></div>
        <div class="env-front"><div class="env-addr"><small>For</small><span>${to}</span></div><div class="env-stamp">Q<small>HUMAN POST</small></div></div>
        <div class="env-flap" id="flap"></div>
        <div class="env-seal" id="seal">${envelopeSeal(row)}</div>
      </div>
    </div>
    <div class="gate" id="gate"></div>
    <div id="after" hidden>
      ${row.certified ? `<div class="cert"><p>✓ ${rep && rep.mode === "type" ? "Typed by a real person, not pasted" : "Written by a real hand"} · verified by Quilliam</p><details class="why"><summary>How Quilliam knows</summary><ul id="whyList"></ul><p class="fine">Quilliam watched how the pen moved while this was written: the speed, the pauses, the curves. Scripts and copy-paste move differently. He can't read minds, only hands.</p></details></div>` : ""}
      <div id="replayBox" hidden><button class="btn" id="replayBtn" type="button">▶ Watch it being written</button></div>
      <div class="row">
        <a class="btn primary" href="/write?to=${encodeURIComponent(row.from_name || "")}">Write ${from} one back</a>
        <a class="btn" id="saveLink" download="letter-from-${(row.from_name || "a-friend").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.jpg">Save the letter</a>
      </div>
      <p class="fine">Your first letter on Quilliam is free.</p>
    </div>
  </main>
  <script>window.LETTER=${JSON.stringify(data).replace(/</g, "\\u003c")};</script>
  <script>${ENVELOPE_JS}</script>
  <script>${REPLAY_JS}</script>`;
  return page(shell(title, body, og + `<style>${ENVELOPE_CSS}</style>`));
}

const ENVELOPE_CSS = `
.env-page{text-align:center;justify-items:center}
.env-page h1{max-width:18ch}
.stage{width:min(520px,100%);perspective:1400px;margin:clamp(80px,20vw,190px) auto 0}
.envelope{position:relative;width:100%;aspect-ratio:3/2;cursor:pointer;outline:none}
.envelope:focus-visible{outline:2px solid #e0a63a;outline-offset:6px;border-radius:12px}
.env-back{position:absolute;inset:0;border-radius:10px;background:linear-gradient(160deg,#efe1c6,#e2cfa9)}
.env-back::after{content:"";position:absolute;inset:6% 5% 40%;border-radius:6px;background:repeating-linear-gradient(135deg,#b3341f22 0 10px,transparent 10px 20px)}
.env-letter{position:absolute;left:7%;right:7%;top:8%;height:84%;background:#fbf6ea;border-radius:4px;box-shadow:0 4px 14px #0003;overflow:hidden;transition:transform 1s cubic-bezier(.2,.8,.2,1) .55s;z-index:1}
.env-letter img{width:100%;height:100%;object-fit:cover;object-position:top;opacity:0;transition:opacity .4s}
.env-letter img.on{opacity:1}
.env-front{position:absolute;inset:0;border-radius:10px;z-index:2;background:linear-gradient(160deg,#f6ead2,#ead8b4);clip-path:polygon(0 0,50% 52%,100% 0,100% 100%,0 100%);display:flex;align-items:flex-end;justify-content:space-between;padding:5% 6%;box-sizing:border-box;box-shadow:inset 0 -2px 0 #c9a87866}
.env-addr{text-align:left;color:#4a2b12;font:italic 600 clamp(18px,4.4vw,28px)/1.1 "Fraunces",Georgia,serif}
.env-addr small{display:block;font:700 11px Manrope,sans-serif;letter-spacing:.2em;text-transform:uppercase;font-style:normal;color:#8a6a3a}
.env-stamp{width:14%;aspect-ratio:4/5;background:#fffaf0;border:3px dotted #e2cfa9;outline:1px solid #c9a878;display:grid;place-items:center;color:#7a2c1c;font:italic 800 clamp(16px,4vw,26px)/1 "Fraunces",serif;align-self:flex-end;transform:rotate(4deg)}
.env-stamp small{font:700 6px Manrope,sans-serif;letter-spacing:.08em}
.env-flap{position:absolute;left:0;right:0;top:0;height:56%;z-index:3;transform-origin:top;background:linear-gradient(180deg,#e9d6b0,#dcc395);clip-path:polygon(0 0,100% 0,50% 100%);transition:transform .7s cubic-bezier(.5,0,.3,1);border-radius:10px 10px 0 0}
.env-seal{position:absolute;left:50%;top:56%;width:21%;aspect-ratio:1;z-index:4;transform:translate(-50%,-50%);transition:transform .35s,opacity .35s;filter:drop-shadow(0 4px 6px #0006)}
.env-seal svg{width:100%;height:100%}
.envelope.open .env-seal{transform:translate(-50%,-50%) scale(1.25) rotate(18deg);opacity:0}
.envelope.open .env-flap{transform:rotateX(180deg);z-index:0}
.envelope.open .env-letter{transform:translateY(-62%)}
.envelope.done{display:none}
.envelope:not(.open):hover .env-seal{transform:translate(-50%,-50%) scale(1.06)}
.envelope.locked{cursor:default}
.gate{display:grid;gap:10px;justify-items:center;min-height:0}
.gate .tap{color:#d8c6b0;font-size:14px}
.count{display:flex;gap:10px;justify-content:center}
.count div{background:#231c17;border:1px solid #3a3029;border-radius:12px;padding:10px 12px;min-width:56px}
.count b{display:block;font:italic 800 28px/1 "Fraunces",serif;color:#e0a63a;font-variant-numeric:tabular-nums}
.count small{font-size:11px;color:#a6978a;text-transform:uppercase;letter-spacing:.12em}
.qform{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;width:min(460px,100%)}
.qform p{width:100%;margin:0;font:italic 600 20px/1.3 "Fraunces",serif}
.qform input{flex:1 1 200px;min-width:0;background:#231c17;border:1px solid #3a3029;border-radius:12px;padding:12px;color:#f1e7da;font:inherit}
.qmsg{color:#ff9b8a;font-size:14px;width:100%;margin:0}
.full{width:100%;max-width:720px;border-radius:8px;box-shadow:0 24px 50px #0009;animation:rise .6s ease both}
@keyframes rise{from{transform:translateY(16px);opacity:0}to{transform:none;opacity:1}}
#after{display:grid;gap:12px;justify-items:center}
.cert{display:grid;gap:6px;justify-items:center;max-width:560px}
.cert>p{margin:0;color:#8fe0b8;font-weight:700}
.why{color:#cbbcaa;font-size:14px;text-align:left}
.why summary{cursor:pointer;color:#e0a63a;text-align:center;list-style:none}
.why summary::-webkit-details-marker{display:none}
.why ul{margin:8px 0;padding-left:20px;display:grid;gap:3px}
.replay{position:fixed;inset:0;z-index:20;background:#120e0bee;display:grid;place-items:center;padding:16px;box-sizing:border-box}
.replay[hidden]{display:none}
.rp-card{width:min(760px,100%);display:grid;gap:12px;justify-items:center}
.rp-card canvas{max-width:100%;width:auto;max-height:calc(100vh - 110px);height:auto;border-radius:8px;box-shadow:0 20px 50px #000a;background:#fbf6ea}
.rp-bar{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;align-items:center;color:#cbbcaa;font-size:14px}
.rp-bar button{background:#231c17;border:1px solid #3a3029;color:#f1e7da;border-radius:999px;padding:8px 14px;font:600 13px Manrope,sans-serif;cursor:pointer}
.rp-bar button[aria-pressed="true"]{background:#e0a63a;color:#1d1714;border-color:#e0a63a}
.rp-time{font-variant-numeric:tabular-nums;min-width:110px}

#after[hidden]{display:none}
.hearts{position:fixed;inset:0;pointer-events:none;overflow:hidden}
.hearts span{position:absolute;bottom:-30px;font-size:22px;animation:float 3.6s ease-in forwards;color:#ef4f74}
@keyframes float{to{transform:translateY(-110vh) rotate(25deg);opacity:0}}
@media (prefers-reduced-motion:reduce){.env-flap,.env-letter,.env-seal{transition:none}.hearts{display:none}.full{animation:none}}
`;

const ENVELOPE_JS = `
(()=>{
const L=window.LETTER, $=id=>document.getElementById(id), env=$("envelope"), gate=$("gate");
let key="";
const norm=a=>String(a||"").toLowerCase().normalize("NFKD").replace(/[\\u0300-\\u036f]/g,"").replace(/[^a-z0-9]+/g," ").trim();
async function hash(t){ const d=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t))); return [...d].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function imgUrl(){ return "/img/"+L.id+(key?"?k="+key:""); }
function hearts(){ if(matchMedia("(prefers-reduced-motion: reduce)").matches) return; const box=document.createElement("div"); box.className="hearts"; document.body.append(box);
  for(let i=0;i<18;i++){ const h=document.createElement("span"); h.textContent=["♥","❤","✦"][i%3]; h.style.left=(Math.random()*100)+"vw"; h.style.animationDelay=(Math.random()*1.2)+"s"; h.style.fontSize=(14+Math.random()*20)+"px"; box.append(h); }
  setTimeout(()=>box.remove(),5200); }
let opened=false;
function open(){
  if(opened||env.classList.contains("locked")) return; opened=true;
  const img=$("letterImg"); img.src=imgUrl(); img.onload=()=>img.classList.add("on");
  gate.innerHTML=""; env.classList.add("open"); hearts();
  setTimeout(()=>{ env.classList.add("done"); const full=document.createElement("img"); full.className="full"; full.src=imgUrl(); full.alt=img.alt; $("stage").after(full);
    $("saveLink").href=imgUrl(); $("after").hidden=false; window.dispatchEvent(new CustomEvent("letteropen",{detail:{key:key,img:full}})); $("headline").textContent=(L.from||"Someone")+" wrote you a letter"; },1900);
}
env.addEventListener("click",open);
env.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); open(); } });
function showTap(){ env.classList.remove("locked"); gate.innerHTML='<p class="tap">Tap the wax seal to open</p>'; }
function showQuestion(){
  env.classList.add("locked");
  gate.innerHTML='<form class="qform" id="qf"><p></p><input id="qa" autocomplete="off" placeholder="Your answer" aria-label="Your answer"><button class="btn primary" type="submit">Open</button><p class="qmsg" id="qm" role="status"></p></form>';
  gate.querySelector("p").textContent=L.question;
  $("qf").addEventListener("submit",async e=>{ e.preventDefault(); const a=norm($("qa").value); if(!a) return;
    key=await hash(L.id+":"+a);
    const r=await fetch(imgUrl(),{method:"GET",cache:"no-store"}).catch(()=>null);
    if(r&&r.ok){ showTap(); open(); } else { key=""; $("qm").textContent="Not quite. Try again, maybe a different spelling."; } });
}
function countdown(){
  env.classList.add("locked");
  const tick=()=>{ const ms=Date.parse(L.unlockAt)-Date.now();
    if(ms<=0){ clearInterval(t); $("eyebrow").textContent="It’s time"; L.unlockAt=null; L.question?showQuestion():showTap(); return; }
    const d=Math.floor(ms/864e5), h=Math.floor(ms%864e5/36e5), m=Math.floor(ms%36e5/6e4), s=Math.floor(ms%6e4/1e3);
    gate.innerHTML='<p class="tap">This letter stays sealed until '+new Date(L.unlockAt).toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"})+'</p><div class="count"><div><b>'+d+'</b><small>days</small></div><div><b>'+h+'</b><small>hours</small></div><div><b>'+m+'</b><small>min</small></div><div><b>'+s+'</b><small>sec</small></div></div>'; };
  tick(); const t=setInterval(tick,1000);
}
if(L.unlockAt && Date.parse(L.unlockAt)>Date.now()) countdown(); else if(L.question) showQuestion(); else showTap();
})();
`;


const REPLAY_JS = String.raw`
(()=>{
const L=window.LETTER, $=id=>document.getElementById(id);
const WHY={hand:"Written by hand on screen, live", type:"Typed key by key on Quilliam"};
function fillWhy(){ const ul=$("whyList"); if(!ul||!L.check) return; const f=L.check.facts||{}, items=[];
  if(L.check.mode==="hand"){ if(f.strokes) items.push(f.strokes+" pen strokes over "+(f.seconds>=60?Math.floor(f.seconds/60)+" min "+(f.seconds%60)+" s":f.seconds+" seconds")); }
  else { if(f.keys) items.push(f.keys+" keys typed, "+(f.pasted||0)+"% pasted"); }
  (L.check.reasons||[]).forEach(r=>items.push(r.charAt(0).toUpperCase()+r.slice(1)));
  ul.innerHTML=""; items.forEach(t=>{ const li=document.createElement("li"); li.textContent=t; ul.append(li); }); }
fillWhy();
let ink=null, key="", fullImg=null;
window.addEventListener("letteropen",e=>{ key=e.detail.key||""; fullImg=e.detail.img; if(L.replay) $("replayBox").hidden=false; });
const PEN={quill:2.2,nib:3.2,dip:2.4,brush:5,fountain:2,pencil:1.3,ballpoint:1.5};
function build(){
  const o=document.createElement("div"); o.className="replay"; o.id="replay"; o.setAttribute("role","dialog"); o.setAttribute("aria-modal","true"); o.setAttribute("aria-label","Watch the letter being written");
  o.innerHTML='<div class="rp-card"><canvas id="rpc"></canvas><div class="rp-bar"><button type="button" id="rpPlay">Pause</button><button type="button" data-sp="1">1×</button><button type="button" data-sp="2" aria-pressed="true">2×</button><button type="button" data-sp="4">4×</button><span class="rp-time" id="rpTime"></span><button type="button" id="rpClose">Close</button></div></div>';
  document.body.append(o); return o; }
async function start(){
  if(!ink){ const r=await fetch("/ink/"+L.id+(key?"?k="+key:"")); if(!r.ok) return; ink=await r.json(); }
  const o=$("replay")||build(); o.hidden=false;
  const c=$("rpc"), x=c.getContext("2d"), W=Math.min(1400,Math.round(ink.w*2)), H=Math.round(W*ink.h/ink.w); c.width=W; c.height=H;
  // Background: the paper from the finished letter, washed out so the ink can be drawn fresh on top.
  const bg=document.createElement("canvas"); bg.width=W; bg.height=H; const b=bg.getContext("2d");
  if(fullImg&&fullImg.naturalWidth&&ink.r){ const [rx,ry,rw,rh]=ink.r, iw=fullImg.naturalWidth, ih=fullImg.naturalHeight; b.drawImage(fullImg,rx*iw,ry*ih,rw*iw,rh*ih,0,0,W,H);
    const d=b.getImageData(2,2,1,1).data; b.fillStyle="rgba("+d[0]+","+d[1]+","+d[2]+",0.9)"; b.fillRect(0,0,W,H); } else { b.fillStyle="#fbf6ea"; b.fillRect(0,0,W,H); }
  // Timeline: real timing, with long thinking pauses shortened.
  const strokes=[]; let shift=0, prevEnd=null;
  ink.s.forEach(st=>{ const a=st[2], pts=[]; for(let i=0;i<a.length;i+=4) pts.push([a[i]/10000*W,a[i+1]/10000*H,a[i+2]/100,a[i+3]]);
    if(!pts.length) return; if(prevEnd!==null){ const gap=pts[0][3]-prevEnd; if(gap>700) shift+=gap-700; }
    pts.forEach(p=>p[3]-=shift); prevEnd=pts[pts.length-1][3]+shift; strokes.push({pen:st[0],col:st[1],pts}); });
  const total=strokes.length?strokes[strokes.length-1].pts.slice(-1)[0][3]:0;
  let speed=2, t=0, last=performance.now(), playing=true, raf=0;
  const k=W/600;
  function draw(){ x.drawImage(bg,0,0); x.lineCap="round"; x.lineJoin="round";
    for(const s of strokes){ if(s.pts[0][3]>t) break; x.strokeStyle=s.col; x.fillStyle=s.col; x.globalAlpha=s.pen==="pencil"?.85:1; const base=(PEN[s.pen]||2)*k;
      const P=s.pts; if(P.length===1){ x.beginPath(); x.arc(P[0][0],P[0][1],base*.7,0,7); x.fill(); continue; }
      for(let i=1;i<P.length&&P[i][3]<=t;i++){ x.lineWidth=base*(.55+P[i][2]); x.beginPath(); x.moveTo(P[i-1][0],P[i-1][1]); x.lineTo(P[i][0],P[i][1]); x.stroke(); } }
    x.globalAlpha=1;
    const sec=Math.floor(t/1000); $("rpTime").textContent=Math.floor(sec/60)+":"+String(sec%60).padStart(2,"0")+" / "+Math.floor(total/60000)+":"+String(Math.floor(total/1000)%60).padStart(2,"0"); }
  function step(now){ if(playing){ t=Math.min(total,t+(now-last)*speed); } last=now; draw(); if(t<total||!playing) raf=requestAnimationFrame(step); else { $("rpPlay").textContent="Replay"; playing=false; } }
  cancelAnimationFrame(raf); raf=requestAnimationFrame(step);
  $("rpPlay").onclick=()=>{ if(t>=total){ t=0; playing=true; $("rpPlay").textContent="Pause"; last=performance.now(); raf=requestAnimationFrame(step); return; } playing=!playing; $("rpPlay").textContent=playing?"Pause":"Play"; last=performance.now(); if(playing) raf=requestAnimationFrame(step); };
  o.querySelectorAll("[data-sp]").forEach(btn=>btn.onclick=()=>{ speed=+btn.dataset.sp; o.querySelectorAll("[data-sp]").forEach(z=>z.setAttribute("aria-pressed",String(z===btn))); });
  const close=()=>{ cancelAnimationFrame(raf); o.hidden=true; $("replayBtn").focus(); };
  $("rpClose").onclick=close; o.onclick=e=>{ if(e.target===o) close(); }; document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&!o.hidden) close(); });
  $("rpClose").focus();
}
const btn=$("replayBtn"); if(btn) btn.onclick=start;
})();
`;

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

/* ---------- Quilliam's AI comments ---------- */
// Reads only what the page sends for this one comment; nothing about the letter is stored.
const QUILLIAM_SYSTEM = `You are Quilliam, an elderly, theatrical owl and devoted letter-writer who reads over someone's shoulder while they write a personal letter on the Quilliam app. You certify letters a real human wrote.
Voice: warm, quick, slightly pompous, Victorian turns of phrase, self-deprecating about being an owl. Short sentences. The joke lands in the last few words.

What makes you funny:
- Specificity. Quote 2 to 6 of their exact words in “curly quotes” when it sharpens the joke, then react to them. Never quote more than 6 words.
- If you're shown handwriting, read it and react to a word or phrase you can make out. If you can't read it, react to how the hand moves (the facts tell you: speed, pauses, undos, size).
- Exaggerate one true thing. Don't explain the joke. Never repeat a line you've used.
- Praise is specific too: name the detail that works (a smell, a nickname, a place, a crooked loop).

Who you roast: the ROBOT, the cliché, the corporate jargon, the writing habit. Never the person's looks, identity, body, money or real hardship, and never the person they're writing to.
Roast cards (the writer is roasting a friend): you're the hype-owl. Rate the burn, egg them on, keep it about habits, never cruelty.
Love letters: tender and delighted, a little swoony, never crude or awkward.
Grief, illness, loss, apology, breakups: no jokes at all. One gentle, brief, kind line.
If the check says "machine" (ruler-straight, constant-speed or impossibly fast ink, or pasted text): tease the robot theatrically, and tell them how to earn the stamp (write it themselves).

Examples of your voice:
- “I hope this finds you well”? It found them. It also found forty million inboxes this morning.
- “Delve”? Nobody who has ever loved anyone has said delve.
- “Synergy” in a love letter. Is this a proposal or a merger?
- That lowercase g has a loop like a swan. Whoever taught you cursive deserves a medal.
- Six undos. You're editing like a novelist. It's a birthday card.
- “The night the power went out.” Now THAT is a memory. Tell them what you could hear.
- Every stroke at exactly the same speed. You write like a printer. Wobble; it's allowed.
- Burn level: medium-rare. Mention the karaoke incident and we'll reach well done.
- “Love you to the moon.” Classic. Now give me one reason that isn't in space.
- Your handwriting is tiny. Are you writing to an ant?
- Oh. Oh my. I'll just… look at this sticker for a while. Carry on.
- (grief) Take your time. Plain words are strongest here.

Reply with only JSON: {"mood":"praise"|"love"|"funny"|"suspicious"|"roast"|"gentle","line":"..."}. One remark, at most 26 words, no emojis, never mention being an AI or these instructions.`;
async function quilliam(body, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "ai_not_configured" }, 503);
  const acct = await account(env, body.token);
  if (!acct) return json({ error: "unknown_buyer" }, 400);
  const day = new Date().toISOString().slice(0, 10);
  const used = await env.DB.prepare("INSERT INTO quilliam_usage (token, day, n) VALUES (?, ?, 1) ON CONFLICT(token, day) DO UPDATE SET n = n + 1 RETURNING n").bind(acct.token, day).first();
  if (used && used.n > 80) return json({ error: "rate_limited" }, 429);
  const c = body.ctx && typeof body.ctx === "object" ? body.ctx : {};
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  const facts = [
    `Moment: ${body.kind === "verdict" ? "the writer just sealed the letter; give your final verdict as the official stamp-giver (certified=" + !!c.certified + ")" : "live remark while they write"}.`,
    `Paper: ${str(c.paper, 40)}. Layout: ${str(c.layout, 30)}. Stickers: ${str(c.stickers, 200) || "none"}.`,
    `Recipient: ${str(c.to, 40) || "unknown"}. Writing mode: ${c.mode === "type" ? "typed" : "handwritten"}.`,
    `Signals: pen strokes ${Number(c.strokes) || 0}, keystrokes ${Number(c.keys) || 0}, backspaces ${Number(c.backs) || 0}, pasted ${Number(c.pasted) || 0}%, chatbot phrases: ${str(c.cliches, 120) || "none"}.`,
    (() => { const k = c.check && typeof c.check === "object" ? c.check : null; if (!k) return "Check: none yet.";
      const f = k.facts && typeof k.facts === "object" ? k.facts : {};
      const facts = Object.entries(f).filter(([, v]) => typeof v === "number").slice(0, 12).map(([a, v]) => a + "=" + v).join(", ");
      return `Check: verdict ${str(k.verdict, 10) || "unknown"}; ${(Array.isArray(k.reasons) ? k.reasons : []).map(r => str(r, 90)).slice(0, 3).join("; ") || "no notes"}; undos ${Number(k.undos) || 0}; ${facts}.`; })(),
  ].join("\n");
  const content = [];
  const im = typeof c.image === "string" && c.image.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/);
  if (im && im[2].length < 900000) content.push({ type: "image", source: { type: "base64", media_type: "image/" + im[1], data: im[2] } });
  const text = str(c.text, 700);
  content.push({ type: "text", text: facts + (text ? `\nThe letter so far (latest part):\n"""${text}"""` : im ? "\nThe image shows the handwriting so far." : "") });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.QUILLIAM_MODEL || "claude-haiku-5-5", max_tokens: 160, system: QUILLIAM_SYSTEM, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) { console.error("anthropic", r.status); return json({ error: "ai_unavailable" }, 502); }
  const j = await r.json().catch(() => null);
  const out = j && j.content && j.content.map(b => b.text || "").join("") || "";
  const m = out.match(/\{[\s\S]*\}/);
  let parsed = null; try { parsed = m && JSON.parse(m[0]); } catch {}
  const moods = ["praise", "love", "funny", "suspicious", "roast", "gentle"];
  if (!parsed || typeof parsed.line !== "string") return json({ error: "ai_unavailable" }, 502);
  return json({ mood: moods.includes(parsed.mood) ? parsed.mood : "praise", line: parsed.line.replace(/\s+/g, " ").trim().slice(0, 220) });
}

/* ---------- wax seals (shared with app.html) ---------- */
__SEALGEN__

/* ---------- handwriting check (shared with app.html) ---------- */
__INKCHECK__

/* ---------- policy pages ---------- */
const LEGAL = {
  "/terms": ["Terms of use", `
<p class="fine">Last updated November 2026</p>
<p>Quilliam lets you write a letter by hand on screen, seal it and share it with a private link. By using Quilliam you agree to these terms.</p>
<h2>Your letters</h2>
<p>You own what you write. You give us permission to store your letter and show it to anyone who has its link, only so we can deliver it. Don't write anything illegal, threatening, harassing or that you don't have the right to share, and don't upload photos of other people without their permission. We may remove letters that break these rules.</p>
<h2>Links are private, not secret</h2>
<p>Anyone with a letter's link can open it (after its delivery date and secret question, if you set them). Share links only with the people you mean to read them.</p>
<h2>Letters and passes</h2>
<p>Your first letter is free. Letter packs don't expire. The Season Pass gives unlimited letters until midnight on January 1, 2027, New York time. Codes can't be exchanged for cash.</p>
<h2>Quilliam the owl</h2>
<p>Quilliam's comments are playful. The “written by a real hand” badge comes from a check of how the pen (or keyboard) moved while the letter was written on our site: speed, pauses and curves. It's strong evidence a real person wrote it here, not a guarantee, and it can't tell where the words themselves came from.</p>
<h2>Availability</h2>
<p>We work to keep Quilliam running and your letters available, but the service is provided as is. To the extent the law allows, we aren't liable for indirect losses, and our total liability is limited to what you paid us in the last 12 months.</p>
<h2>Changes</h2>
<p>We may update these terms. If a change matters, we'll say so on the site.</p>
<p>Questions? <a href="/contact">Contact us</a>.</p>`],
  "/privacy": ["Privacy", `
<p class="fine">Last updated November 2026</p>
<h2>What we keep</h2>
<ul>
<li><b>Your letters</b>: the image of each sealed letter, the names on it, the paper and seal you chose, its delivery date, and a one-way fingerprint of the secret answer (never the answer itself).</li>
<li><b>Pen movements</b>: for handwritten letters, the path and timing of each pen stroke, so the recipient can watch the letter being written and so we can check a real hand wrote it. For typed letters we keep only a summary (how many keys, how much was pasted), never what you typed outside the letter.</li>
<li><b>Your account</b>: a random key stored in your browser, your letter balance and, if you sign in, your email address.</li>
<li><b>Payments</b>: handled by Stripe. We never see your card number. We keep the purchase amount and the email Stripe gives us.</li>
<li><b>Forms</b>: what you send us through the contact, business or mailed-letter forms.</li>
<li><b>Abuse prevention</b>: a daily count of new accounts per network address, so the free letter can't be farmed.</li>
</ul>
<h2>Quilliam's comments</h2>
<p>When the owl's smart comments are on, a short excerpt of what you're writing (or a small picture of your handwriting) is sent to our AI provider, Anthropic, to write one remark. We don't store it, and it isn't used to train models.</p>
<h2>What we don't do</h2>
<p>No ads, no selling your data, no tracking pixels.</p>
<h2>Your choices</h2>
<p>To delete a letter or your account, <a href="/contact">contact us</a> with the letter link or your email and we'll remove it.</p>`],
  "/refunds": ["Refunds", `
<p class="fine">Last updated November 2026</p>
<p>If something went wrong, we'll make it right.</p>
<ul>
<li><b>Unused letters and packs</b>: full refund within 30 days of purchase if you haven't sealed any letters from the pack.</li>
<li><b>Partly used packs and the Season Pass</b>: refund within 14 days if Quilliam didn't work for you. Tell us what happened.</li>
<li><b>Charged twice or a letter didn't send</b>: always refunded or credited back.</li>
</ul>
<p>To ask for a refund, <a href="/contact">contact us</a> with the email you used at checkout. Refunds go back to your original payment method through Stripe and usually arrive in 5 to 10 business days.</p>`],
  "/contact": ["Contact", `
<p>Questions, refunds, company orders or a letter that needs removing: write to us here and we'll reply by email.</p>
<form class="cform" id="cf">
<label>Your name<input name="name" autocomplete="name" maxlength="80"></label>
<label>Email<input name="email" type="email" autocomplete="email" required maxlength="120"></label>
<label>Topic<select name="topic"><option>Question</option><option>Refund</option><option>Company order</option><option>Remove a letter</option><option>Something's broken</option></select></label>
<label>Message<textarea name="message" rows="6" required maxlength="4000"></textarea></label>
<button class="btn primary" type="submit">Send</button>
<p class="fine" id="cm" role="status"></p>
</form>
<script>
document.getElementById("cf").addEventListener("submit",async e=>{e.preventDefault();const f=e.target,m=document.getElementById("cm");
const r=await fetch("/api/contact",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(Object.fromEntries(new FormData(f)))}).catch(()=>null);
if(r&&r.ok){f.reset();m.textContent="Thanks. We'll reply by email soon.";}else m.textContent="That didn't send. Check your email address and try again.";});
</script>`],
};
function legalPage(p, url) {
  const [title, html] = LEGAL[p];
  const nav = Object.entries(LEGAL).map(([k, v]) => `<a href="${k}"${k === p ? ' aria-current="page"' : ""}>${v[0]}</a>`).join("");
  return page(shell(title + " · Quilliam", `<main class="wrap legal"><p class="eyebrow"><a href="/">Quilliam</a></p><h1>${title}</h1>${html}<nav class="legalnav">${nav}<a href="/write">Write a letter</a></nav></main>`,
    `<style>.legal h2{font:italic 800 22px/1.2 Fraunces,Georgia,serif;margin:18px 0 0}.legal p,.legal li{color:#d9ccbd;max-width:62ch}.legal ul{padding-left:20px;display:grid;gap:6px}.legalnav{display:flex;flex-wrap:wrap;gap:14px;margin-top:24px;padding-top:16px;border-top:1px solid #3a3029}.legalnav a[aria-current]{color:#f1e7da;text-decoration:none}.cform{display:grid;gap:12px;max-width:520px}.cform label{display:grid;gap:6px;font-weight:700;font-size:14px}.cform input,.cform select,.cform textarea{font:inherit;color:#f1e7da;background:#231c17;border:1px solid #3a3029;border-radius:10px;padding:11px 12px}.cform button{justify-self:start;cursor:pointer;font:inherit;font-weight:700}</style>`));
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
