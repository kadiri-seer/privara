// Vercel serverless function: receives early-access applications and forwards them to the Privara team.
//
// Configure at least one destination in Vercel → Project → Settings → Environment Variables:
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   applications arrive as Telegram messages (recommended)
//   APPLY_WEBHOOK_URL                        JSON POST to any webhook (Zapier, Make, Slack, Discord, …)
// Nothing is stored by this function.

const LIMITS = {
  product: 120,
  website: 200,
  description: 1500,
  category: 60,
  stage: 40,
  name: 120,
  email: 200,
  handle: 80,
  volume: 120,
};
const CATEGORIES = ["Trading or finance agent", "Customer support agent", "Coding agent", "Personal assistant", "Research or data agent", "Sales or marketing agent", "Other"];
const STAGES = ["Idea", "Prototype", "In production"];
const ACTIONS = ["Sends emails or messages", "Moves money or trades", "Reads or writes files", "Runs code", "Browses the web", "Handles customer data", "Calls third-party APIs"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_FILL_MS = 3000;

// Best-effort per-instance throttle (serverless instances are short-lived; this only blunts bursts).
const recent = new Map();
function throttled(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  hits.push(now);
  recent.set(ip, hits);
  return hits.length > 5;
}

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

function validate(body) {
  const errors = {};
  const data = {
    product: clean(body.product, LIMITS.product),
    website: clean(body.website, LIMITS.website),
    description: clean(body.description, LIMITS.description),
    category: clean(body.category, LIMITS.category),
    stage: clean(body.stage, LIMITS.stage),
    actions: Array.isArray(body.actions) ? body.actions.filter((a) => ACTIONS.includes(a)) : [],
    volume: clean(body.volume, LIMITS.volume),
    name: clean(body.name, LIMITS.name),
    email: clean(body.email, LIMITS.email),
    handle: clean(body.handle, LIMITS.handle),
    consent: body.consent === true,
  };
  if (data.product.length < 2) errors.product = "Tell us the name of your agent or product.";
  if (data.website && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(data.website)) errors.website = "Use a full link starting with https://";
  if (data.description.length < 20) errors.description = "Describe what your agent does in at least a sentence.";
  if (!CATEGORIES.includes(data.category)) errors.category = "Choose what kind of agent it is.";
  if (!STAGES.includes(data.stage)) errors.stage = "Choose how far along it is.";
  if (data.name.length < 2) errors.name = "Tell us your name.";
  if (!EMAIL_RE.test(data.email)) errors.email = "Enter an email address we can reach you at.";
  if (!data.consent) errors.consent = "Please agree so we can contact you about early access.";
  return { data, errors };
}

function telegramText(d) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  return [
    "<b>New Privara early-access application</b>",
    "",
    `<b>Product:</b> ${esc(d.product)}`,
    d.website ? `<b>Link:</b> ${esc(d.website)}` : null,
    `<b>Type:</b> ${esc(d.category)} · <b>Stage:</b> ${esc(d.stage)}`,
    d.actions.length ? `<b>Its agent can:</b> ${esc(d.actions.join(", "))}` : null,
    d.volume ? `<b>Scale:</b> ${esc(d.volume)}` : null,
    "",
    esc(d.description),
    "",
    `<b>Contact:</b> ${esc(d.name)} — ${esc(d.email)}${d.handle ? ` — ${esc(d.handle)}` : ""}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

async function deliver(d, env, fetchImpl) {
  const jobs = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(
      fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: telegramText(d), parse_mode: "HTML", disable_web_page_preview: true }),
      }),
    );
  }
  if (env.APPLY_WEBHOOK_URL) {
    jobs.push(
      fetchImpl(env.APPLY_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "privara.early_access_application", submitted_at: new Date().toISOString(), ...d }),
      }),
    );
  }
  if (!jobs.length) return "not_configured";
  const results = await Promise.allSettled(jobs);
  const ok = results.some((r) => r.status === "fulfilled" && r.value.ok);
  return ok ? "delivered" : "failed";
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20_000) throw Object.assign(new Error("too large"), { code: "too_large" });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function handler(req, res, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (req.method !== "POST") return send(res, 405, { error: { code: "method_not_allowed", message: "Use POST." } });
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return send(res, e.code === "too_large" ? 413 : 400, { error: { code: "bad_request", message: "That request couldn't be read." } });
  }
  if (!body || typeof body !== "object") return send(res, 400, { error: { code: "bad_request", message: "That request couldn't be read." } });

  // Spam guards: a hidden field people never fill, and a minimum time on the form.
  if (body.company_fax) return send(res, 200, { ok: true });
  if (typeof body.started_at !== "number" || Date.now() - body.started_at < MIN_FILL_MS) {
    return send(res, 400, { error: { code: "too_fast", message: "That was quick. Please check your answers and submit again." } });
  }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (throttled(ip)) return send(res, 429, { error: { code: "too_many", message: "Too many applications from this connection. Try again later." } });

  const { data, errors } = validate(body);
  if (Object.keys(errors).length) return send(res, 422, { error: { code: "invalid", message: "Some answers need attention.", fields: errors } });

  const outcome = await deliver(data, env, fetchImpl);
  if (outcome === "not_configured") {
    return send(res, 503, { error: { code: "not_configured", message: "Applications aren't being accepted yet. Please reach us on Telegram or X instead." } });
  }
  if (outcome === "failed") {
    return send(res, 502, { error: { code: "delivery_failed", message: "We couldn't receive your application just now. Please try again in a minute." } });
  }
  return send(res, 200, { ok: true });
}

module.exports = handler;
module.exports.default = handler;
module.exports._internal = { validate, telegramText, CATEGORIES, STAGES, ACTIONS, recent };
