// @vitest-environment node
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handler: any = require("../../../api/apply.js");

const VALID = {
  product: "Ledgerly",
  website: "https://ledgerly.example",
  description: "An autonomous bookkeeping agent that reconciles invoices and pays suppliers.",
  category: "Trading or finance agent",
  stage: "Prototype",
  actions: ["Moves money or trades", "Sends emails or messages", "not-a-real-option"],
  volume: "200 businesses",
  name: "Ada Obi",
  email: "ada@ledgerly.example",
  handle: "@ada",
  consent: true,
};

function call(body: unknown, { env = {}, fetchImpl = vi.fn(), ip = "1.1.1.1", method = "POST" } = {}) {
  const res = { statusCode: 0, headers: {} as Record<string, string>, body: "", setHeader(k: string, v: string) { this.headers[k] = v; }, end(b: string) { this.body = b; } };
  const req = { method, headers: { "x-forwarded-for": ip }, body };
  return handler(req, res, { env, fetchImpl }).then(() => ({ status: res.statusCode, json: JSON.parse(res.body), headers: res.headers }));
}

const okFetch = () => vi.fn().mockResolvedValue({ ok: true });
const TG = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "-100" };
let n = 0;
const fresh = () => `10.0.0.${++n}`;

describe("early access endpoint", () => {
  beforeEach(() => handler._internal.recent.clear());

  it("forwards a valid application to Telegram", async () => {
    const fetchImpl = okFetch();
    const r = await call({ ...VALID, started_at: Date.now() - 10_000 }, { env: TG, fetchImpl, ip: fresh() });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const sent = JSON.parse(init.body);
    expect(sent.chat_id).toBe("-100");
    expect(sent.text).toContain("Ledgerly");
    expect(sent.text).toContain("Moves money or trades");
    expect(sent.text).not.toContain("not-a-real-option");
  });

  it("escapes HTML in Telegram messages", () => {
    const text = handler._internal.telegramText({ ...VALID, actions: [], product: "<b>x</b>" });
    expect(text).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("also posts to a generic webhook", async () => {
    const fetchImpl = okFetch();
    await call({ ...VALID, started_at: Date.now() - 10_000 }, { env: { APPLY_WEBHOOK_URL: "https://hooks.example/x" }, fetchImpl, ip: fresh() });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ type: "privara.early_access_application", product: "Ledgerly" });
  });

  it("validates fields and reports them", async () => {
    const r = await call({ product: "", email: "nope", consent: false, started_at: Date.now() - 10_000 }, { env: TG, fetchImpl: okFetch(), ip: fresh() });
    expect(r.status).toBe(422);
    expect(Object.keys(r.json.error.fields)).toEqual(expect.arrayContaining(["product", "description", "category", "stage", "name", "email", "consent"]));
  });

  it("silently drops bot submissions and rejects instant ones", async () => {
    const fetchImpl = okFetch();
    const bot = await call({ ...VALID, company_fax: "spam", started_at: Date.now() - 10_000 }, { env: TG, fetchImpl, ip: fresh() });
    expect(bot.status).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();
    const fast = await call({ ...VALID, started_at: Date.now() }, { env: TG, fetchImpl, ip: fresh() });
    expect(fast.json.error.code).toBe("too_fast");
  });

  it("says so when no destination is configured or delivery fails", async () => {
    expect((await call({ ...VALID, started_at: Date.now() - 10_000 }, { env: {}, ip: fresh() })).status).toBe(503);
    const failing = vi.fn().mockResolvedValue({ ok: false });
    expect((await call({ ...VALID, started_at: Date.now() - 10_000 }, { env: TG, fetchImpl: failing, ip: fresh() })).status).toBe(502);
  });

  it("throttles bursts from one address and only accepts POST", async () => {
    const ip = fresh();
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await call({ ...VALID, started_at: Date.now() - 10_000 }, { env: TG, fetchImpl: okFetch(), ip })).status;
    expect(last).toBe(429);
    expect((await call({}, { method: "GET" })).status).toBe(405);
  });
});
