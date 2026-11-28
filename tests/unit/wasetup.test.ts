// WhatsApp connection setup against a fake Graph API: the right calls, nothing secret in the answers.
import { describe, expect, it } from "vitest";
import { runSetup, TEMPLATES } from "@shared/whatsapp/setup.ts";

const TOKEN = "EAAG-secret-token-value-123456";
const env = { token: TOKEN, callbackUrl: "https://x.supabase.co/functions/v1/whatsapp", verifyToken: "verify-word", wabaId: "1111111111", phoneNumberId: null };

function fakeGraph(responses: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const g = async (method: "GET" | "POST", path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const key = Object.keys(responses).find((k) => `${method} ${path}`.startsWith(k));
    const data = key ? responses[key] : { success: true };
    return { ok: !(data as any)?.error, status: (data as any)?.error ? 400 : 200, data };
  };
  return { g, calls };
}

describe("WhatsApp setup", () => {
  it("status lists the accounts and numbers the token can manage, without the token", async () => {
    const { g } = fakeGraph({
      "GET debug_token": { data: { is_valid: true, app_id: "999", expires_at: 0, granular_scopes: [
        { scope: "whatsapp_business_management", target_ids: ["1111111111"] }, { scope: "whatsapp_business_messaging", target_ids: ["1111111111"] }] } },
      "GET 1111111111/phone_numbers": { data: [{ id: "776564935538805", display_phone_number: "+54 9 11 5555-0000", verified_name: "Customer Line" }] },
      "GET 1111111111": { id: "1111111111", name: "BCU" },
    });
    const r = await runSetup("status", {}, env, g);
    expect(r.ok).toBe(true);
    expect(r.body).toMatchObject({ tokenValid: true, appId: "999", permissions: ["whatsapp_business_management", "whatsapp_business_messaging"] });
    expect((r.body.accounts as any)[0].phoneNumbers[0].id).toBe("776564935538805");
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });

  it("adds, verifies and registers a new number; saves its ID", async () => {
    const { g, calls } = fakeGraph({ "POST 1111111111/phone_numbers": { id: "222333444555" } });
    const add = await runSetup("add_number", { countryCode: "+54", phoneNumber: "9 11 5555-1234", displayName: "SoyTuTaxi" }, env, g);
    expect(add.save).toEqual({ phoneNumberId: "222333444555", wabaId: "1111111111" });
    expect(calls[0].body).toEqual({ cc: "54", phone_number: "91155551234", verified_name: "SoyTuTaxi" });

    const e2 = { ...env, phoneNumberId: "222333444555" };
    expect((await runSetup("request_code", { method: "SMS" }, e2, g)).ok).toBe(true);
    expect((await runSetup("verify_code", { code: "12" }, e2, g)).body).toEqual({ error: { code: "invalid_code" } });
    expect((await runSetup("verify_code", { code: "123-456" }, e2, g)).ok).toBe(true);
    expect(calls.at(-1)).toMatchObject({ path: "222333444555/verify_code", body: { code: "123456" } });
    expect((await runSetup("register", { pin: "1234" }, e2, g)).ok).toBe(false);
    const reg = await runSetup("register", { pin: "654321" }, e2, g);
    expect(reg.save?.phoneNumberId).toBe("222333444555");
    expect(calls.at(-1)!.body).toEqual({ messaging_product: "whatsapp", pin: "654321" });
  });

  it("sends only this number's webhooks to SoyTuTaxi and enables calling", async () => {
    const { g, calls } = fakeGraph({ "GET 222333444555?fields=webhook_configuration": { webhook_configuration: { phone_number: env.callbackUrl } },
      "GET 222333444555/settings": { calling: { status: "ENABLED" } } });
    const e2 = { ...env, phoneNumberId: "222333444555" };
    const w = await runSetup("webhook", {}, e2, g);
    expect(w.ok).toBe(true);
    expect(calls[0]).toMatchObject({ method: "POST", path: "1111111111/subscribed_apps" });
    expect(calls[0].body).toBeUndefined();                                   // no WABA-wide override: other lines untouched
    expect(calls[1]).toEqual({ method: "POST", path: "222333444555", body: { webhook_configuration: { override_callback_uri: env.callbackUrl, verify_token: "verify-word" } } });
    const c = await runSetup("calling", {}, e2, g);
    expect(c.body).toEqual({ calling: { status: "ENABLED" } });
    expect(calls.find((x) => x.path === "222333444555/settings" && x.method === "POST")!.body).toEqual({ calling: { status: "ENABLED", call_icon_visibility: "DEFAULT", sip: { status: "DISABLED" } } });
  });

  it("reports Meta's refusal (e.g. messaging limit too low for calling) in plain words", async () => {
    const { g } = fakeGraph({ "POST 222333444555/settings": { error: { code: 138006, message: "Calling is not available", error_user_msg: "Messaging limit below 2000" } } });
    const r = await runSetup("calling", {}, { ...env, phoneNumberId: "222333444555" }, g);
    expect(r).toMatchObject({ ok: false, body: { error: { code: "meta_error", meta: { code: 138006, message: "Messaging limit below 2000" } } } });
  });

  it("creates missing templates once and maps them to notifications", async () => {
    const { g, calls } = fakeGraph({ "GET 1111111111/message_templates": { data: [{ name: "stt_trip_confirmed", status: "APPROVED", language: "es_AR" }] },
      "POST 1111111111/message_templates": { id: "t1", status: "PENDING" } });
    const r = await runSetup("templates", {}, env, g);
    const created = calls.filter((c) => c.method === "POST");
    expect(created).toHaveLength(TEMPLATES.length - 1);                      // the existing one is not re-created
    expect(r.save!.templates!["notify.passenger.confirmed"]).toEqual({ name: "stt_trip_confirmed", language: "es_AR" });
    expect(Object.keys(r.save!.templates!)).toHaveLength(TEMPLATES.length);
    for (const t of TEMPLATES) {                                              // Meta rules: no variable at the start or end
      expect(t.body.trim().startsWith("{{")).toBe(false);
      expect(t.body.trim().endsWith("}}")).toBe(false);
      expect((t.body.match(/\{\{\d\}\}/g) ?? []).length).toBe(t.example.length);
    }
  });

  it("refuses to run without the stored token", async () => {
    const { g } = fakeGraph();
    expect((await runSetup("status", {}, { ...env, token: "" }, g)).body).toEqual({ error: { code: "token_missing" } });
  });
});

describe("WhatsApp setup — app webhook fields (read-only)", () => {
  it("reports the app's subscribed fields using the app secret, without changing anything", async () => {
    const { g } = fakeGraph({ "GET debug_token": { data: { is_valid: true, app_id: "999", granular_scopes: [] } } });
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ data: [{ object: "whatsapp_business_account", callback_url: "https://other.example/hook",
        fields: [{ name: "messages" }, { name: "message_template_status_update" }] }] }));
    }) as unknown as typeof fetch;
    const r = await runSetup("status", {}, { ...env, appSecret: "app-secret-xyz", fetchImpl }, g);
    expect(r.body.appWebhook).toEqual({ fields: ["messages", "message_template_status_update"], defaultCallback: "https://other.example/hook" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/\/999\/subscriptions\?access_token=/);        // a GET: nothing is modified
    expect(JSON.stringify(r.body)).not.toContain("app-secret-xyz");
  });
});

describe("templates match what the notifier sends", () => {
  it("every template has as many {{n}} as the notifier's params, and the offer has Accept/Decline buttons", async () => {
    const { TEMPLATES } = await import("@shared/whatsapp/setup.ts");
    // params per kind, as built in notify.ts
    const expected: Record<string, number> = {
      "notify.passenger.confirmed": 5, "notify.passenger.cancelled": 1, "notify.passenger.payment_due": 4,
      "notify.passenger.pickup_changed": 3, "notify.passenger.reminder": 3, "notify.passenger.rating": 1,
      "notify.passenger.refund": 1, "notify.driver.offer": 3, "notify.driver.assigned": 2,
      "notify.driver.pickup_changed": 2, "notify.driver.released": 2, "notify.staff.message": 2, "notify.driver.invite": 2, "notify.driver.approved": 2,
    };
    for (const t of TEMPLATES) {
      const n = new Set(t.body.match(/\{\{\d+\}\}/g)).size;
      expect(n, t.name).toBe(expected[t.kind]);
      expect(t.example.length, t.name).toBe(n);
      expect(/^\{\{|\}\}[.!]?$/.test(t.body.trim()), `${t.name} must not start/end with a variable`).toBe(false);
      for (const b of t.buttons ?? []) expect(b.length).toBeLessThanOrEqual(25);
    }
    expect(TEMPLATES.find((t) => t.kind === "notify.driver.offer")?.buttons).toHaveLength(2);
  });
});
