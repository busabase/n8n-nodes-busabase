import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BusabaseTrigger } from "./BusabaseTrigger.node";

/**
 * `webhook()`'s signature check is tested here against a HAND-COMPUTED HMAC
 * using the exact algorithm Busabase's dispatcher uses — read directly from
 * `packages/busabase-core/src/domains/webhook/logic/dispatch.ts`
 * (`createHmac("sha256", secret).update(rawBody).digest("hex")`, header
 * `X-Busabase-Signature`), not guessed. This proves the crypto is correct
 * without needing a live delivery.
 *
 * A live delivery round-trip (Busabase's dispatcher actually POSTing to this
 * node, this node verifying the REAL bytes) was run manually against a live
 * dev server for `webhookMethods.default.create/checkExists/delete`'s REST
 * shape, and separately Busabase's own SSRF guard was confirmed to correctly
 * refuse a loopback delivery target from any process outside its Vitest-gated
 * test escape hatch — so a genuine end-to-end dispatch-to-this-node round
 * trip could not be exercised from this package without either weakening
 * that guard's scope or pulling the (heavyweight, app-internal)
 * `busabase-core` package into this lightweight integration package's test
 * suite. That gap is disclosed, not silently skipped — see this PR's
 * changelog.
 */

const sign = (secret: string, body: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

const makeWebhookContext = (opts: {
  secret?: string;
  rawBody?: Buffer;
  signatureHeader?: string;
}) => {
  const statusMock = vi.fn().mockReturnValue({ send: vi.fn() });
  const context = {
    getWorkflowStaticData: () => ({ secret: opts.secret }),
    getRequestObject: () => (opts.rawBody === undefined ? {} : { rawBody: opts.rawBody }),
    getHeaderData: () => ({
      ...(opts.signatureHeader !== undefined
        ? { "x-busabase-signature": opts.signatureHeader }
        : {}),
    }),
    getBodyData: () => (opts.rawBody ? JSON.parse(opts.rawBody.toString("utf8")) : {}),
    getResponseObject: () => ({ status: statusMock }),
    helpers: { returnJsonArray: (data: unknown[]) => data.map((json) => ({ json })) },
  };
  return { context, statusMock };
};

describe("BusabaseTrigger.webhook — signature verification", () => {
  const trigger = new BusabaseTrigger();
  // Signing fixture, not a credential — named so it cannot be mistaken for one.
  const signingFixture = "not-a-real-credential-0123456789";
  const rawBody = Buffer.from(JSON.stringify({ event: "record.created", recordId: "rec_1" }));

  it("accepts a delivery signed with the correct secret", async () => {
    const { context } = makeWebhookContext({
      secret: signingFixture,
      rawBody,
      signatureHeader: sign(signingFixture, rawBody.toString("utf8")),
    });
    const result = await trigger.webhook.call(context as never);
    expect(result.noWebhookResponse).toBeUndefined();
    expect(result.workflowData?.[0]?.[0]?.json).toEqual({
      event: "record.created",
      recordId: "rec_1",
    });
  });

  it("rejects a delivery signed with the WRONG secret", async () => {
    const { context, statusMock } = makeWebhookContext({
      secret: signingFixture,
      rawBody,
      signatureHeader: sign("a-different-fixture", rawBody.toString("utf8")),
    });
    const result = await trigger.webhook.call(context as never);
    expect(result.noWebhookResponse).toBe(true);
    expect(statusMock).toHaveBeenCalledWith(401);
  });

  it("rejects a delivery whose body was tampered with after signing", async () => {
    const validSignature = sign(signingFixture, rawBody.toString("utf8"));
    const { context } = makeWebhookContext({
      secret: signingFixture,
      rawBody: Buffer.from(JSON.stringify({ event: "record.created", recordId: "rec_EVIL" })),
      signatureHeader: validSignature,
    });
    const result = await trigger.webhook.call(context as never);
    expect(result.noWebhookResponse).toBe(true);
  });

  it("rejects when the signature header is missing entirely", async () => {
    const { context } = makeWebhookContext({ secret: signingFixture, rawBody });
    const result = await trigger.webhook.call(context as never);
    expect(result.noWebhookResponse).toBe(true);
  });

  it("fails CLOSED when rawBody is unavailable, rather than trusting a re-parsed body", async () => {
    const { context } = makeWebhookContext({
      secret: signingFixture,
      signatureHeader: sign(signingFixture, rawBody.toString("utf8")),
      // rawBody deliberately omitted
    });
    const result = await trigger.webhook.call(context as never);
    expect(result.noWebhookResponse).toBe(true);
  });

  it("fails closed when no secret was ever stored (workflow static data lost)", async () => {
    const { context } = makeWebhookContext({
      rawBody,
      signatureHeader: sign(signingFixture, rawBody.toString("utf8")),
      // secret deliberately omitted
    });
    const result = await trigger.webhook.call(context as never);
    expect(result.noWebhookResponse).toBe(true);
  });

  it("does not throw on a signature of a different length than expected", async () => {
    // timingSafeEqual throws on mismatched buffer lengths — the guard around
    // it must catch that, not let it become an unhandled 500.
    const { context } = makeWebhookContext({
      secret: signingFixture,
      rawBody,
      signatureHeader: "short",
    });
    await expect(trigger.webhook.call(context as never)).resolves.toMatchObject({
      noWebhookResponse: true,
    });
  });
});

describe("BusabaseTrigger.webhookMethods.default — registration lifecycle", () => {
  const trigger = new BusabaseTrigger();

  const makeHookContext = (
    params: Record<string, unknown>,
    staticData: Record<string, unknown>,
    responses: Record<string, unknown>,
  ) => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const httpRequestWithAuthentication = vi.fn(async (_type, options) => {
      calls.push({ method: options.method, url: options.url, body: options.body });
      const key = `${options.method} ${new URL(options.url).pathname}`;
      if (responses[key] instanceof Error) throw responses[key];
      return responses[key];
    });
    return {
      context: {
        getWorkflowStaticData: () => staticData,
        getNodeWebhookUrl: () => "https://n8n.example/webhook/abc123",
        getNodeParameter: (name: string, fallback: unknown) => params[name] ?? fallback,
        getWorkflow: () => ({ name: "My Workflow" }),
        getNode: () => ({ name: "Busabase Trigger" }),
        getCredentials: vi.fn().mockResolvedValue({ baseUrl: "https://busabase.example" }),
        // delete() logs rather than silently swallowing a failed cleanup.
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
        helpers: { httpRequestWithAuthentication },
      },
      calls,
    };
  };

  it("create() registers a webhook rule with the New Record event and stores its id + secret", async () => {
    const staticData: Record<string, unknown> = {};
    const { context, calls } = makeHookContext({ event: "new", baseId: "bas_1" }, staticData, {
      "POST /api/v1/webhooks": { id: "wh_1" },
    });
    const ok = await trigger.webhookMethods.default.create.call(context as never);
    expect(ok).toBe(true);
    expect(staticData.webhookRuleId).toBe("wh_1");
    expect(typeof staticData.secret).toBe("string");
    expect((staticData.secret as string).length).toBeGreaterThanOrEqual(32);

    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.eventType).toBe("record.created");
    expect(body.baseId).toBe("bas_1");
    expect(body.actionKind).toBe("webhook");
    expect((body.config as { targetUrl: string }).targetUrl).toBe(
      "https://n8n.example/webhook/abc123",
    );
    expect((body.config as { secret: string }).secret).toBe(staticData.secret);
  });

  it("create() maps the Updated Record event and a blank Base to a space-wide rule", async () => {
    const staticData: Record<string, unknown> = {};
    const { calls, context } = makeHookContext({ event: "updated", baseId: "" }, staticData, {
      "POST /api/v1/webhooks": { id: "wh_2" },
    });
    await trigger.webhookMethods.default.create.call(context as never);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.eventType).toBe("record.updated");
    expect(body.baseId).toBeNull();
  });

  it("checkExists() reports true when the stored rule still exists", async () => {
    const staticData = { webhookRuleId: "wh_1" };
    const { context } = makeHookContext({}, staticData, {
      "GET /api/v1/webhooks/wh_1": { id: "wh_1" },
    });
    expect(await trigger.webhookMethods.default.checkExists.call(context as never)).toBe(true);
  });

  it("checkExists() reports false and clears static data when the rule was removed out-of-band", async () => {
    const staticData: Record<string, unknown> = { webhookRuleId: "wh_1", secret: "s" };
    const notFound = Object.assign(new Error("not found"), { httpCode: 404 });
    const { context } = makeHookContext({}, staticData, { "GET /api/v1/webhooks/wh_1": notFound });
    expect(await trigger.webhookMethods.default.checkExists.call(context as never)).toBe(false);
    expect(staticData.webhookRuleId).toBeUndefined();
    expect(staticData.secret).toBeUndefined();
  });

  it("checkExists() reports false without registering anything when nothing was ever created", async () => {
    const { context } = makeHookContext({}, {}, {});
    expect(await trigger.webhookMethods.default.checkExists.call(context as never)).toBe(false);
  });

  it("delete() removes the rule and clears static data", async () => {
    const staticData: Record<string, unknown> = { webhookRuleId: "wh_1", secret: "s" };
    const { context, calls } = makeHookContext({}, staticData, {
      "DELETE /api/v1/webhooks/wh_1": { success: true },
    });
    expect(await trigger.webhookMethods.default.delete.call(context as never)).toBe(true);
    expect(calls[0]?.method).toBe("DELETE");
    expect(staticData.webhookRuleId).toBeUndefined();
    expect(staticData.secret).toBeUndefined();
  });

  it("delete() still succeeds (best-effort) when the rule is already gone", async () => {
    const staticData: Record<string, unknown> = { webhookRuleId: "wh_1", secret: "s" };
    const gone = Object.assign(new Error("not found"), { httpCode: 404 });
    const { context } = makeHookContext({}, staticData, { "DELETE /api/v1/webhooks/wh_1": gone });
    expect(await trigger.webhookMethods.default.delete.call(context as never)).toBe(true);
    expect(staticData.webhookRuleId).toBeUndefined();
  });

  it("delete() is a no-op success when nothing was ever registered", async () => {
    const { context, calls } = makeHookContext({}, {}, {});
    expect(await trigger.webhookMethods.default.delete.call(context as never)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
