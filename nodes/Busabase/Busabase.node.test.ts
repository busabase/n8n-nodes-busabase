import { describe, expect, it, vi } from "vitest";
import { Busabase } from "./Busabase.node";

/**
 * `execute()`'s branching logic, verified against a mocked
 * `httpRequestWithAuthentication` — proves each operation builds the right
 * request and shapes the right output, not that a real server answers that
 * way (that half was verified live; see the changelog for this PR).
 */

interface Call {
  method: string;
  path: string;
  qs?: Record<string, unknown>;
  body?: unknown;
}

const makeContext = (itemParams: Record<string, unknown>[], responder: (call: Call) => unknown) => {
  const calls: Call[] = [];
  const httpRequestWithAuthentication = vi.fn(async (_type, options) => {
    const call: Call = {
      method: options.method,
      path: new URL(options.url).pathname,
      qs: options.qs,
      body: options.body,
    };
    calls.push(call);
    return responder(call);
  });
  const context = {
    getInputData: () => itemParams.map(() => ({ json: {} })),
    getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) =>
      itemParams[itemIndex]?.[name] ?? fallback,
    getCredentials: vi.fn().mockResolvedValue({ baseUrl: "https://busabase.example" }),
    continueOnFail: () => false,
    getNode: () => ({ name: "Busabase" }),
    helpers: {
      httpRequestWithAuthentication,
      returnJsonArray: (data: unknown[]) => data.map((json) => ({ json })),
    },
  };
  return { context, calls };
};

const node = new Busabase();

describe("execute — list", () => {
  it("pages with the cursor until returnAll exhausts the Base", async () => {
    const pages: Record<string, unknown>[][] = [[{ id: "r1" }, { id: "r2" }], [{ id: "r3" }]];
    let call = 0;
    const { context, calls } = makeContext(
      [{ operation: "list", baseId: "bas_1", returnAll: true, status: "active" }],
      () => {
        const records = pages[call] ?? [];
        const nextCursor = call < pages.length - 1 ? `cursor-${call}` : null;
        call += 1;
        return { records, nextCursor };
      },
    );
    const [rows] = await node.execute.call(context as never);
    expect(rows.map((r) => r.json)).toEqual([{ id: "r1" }, { id: "r2" }, { id: "r3" }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.qs?.cursor).toBe("cursor-0");
  });

  it("stops at the requested limit without returnAll, without asking the server to page forever", async () => {
    const { context } = makeContext(
      [{ operation: "list", baseId: "bas_1", returnAll: false, limit: 2, status: "active" }],
      () => ({ records: [{ id: "r1" }, { id: "r2" }, { id: "r3" }], nextCursor: "more" }),
    );
    const [rows] = await node.execute.call(context as never);
    expect(rows).toHaveLength(2);
  });

  it("passes the status filter through", async () => {
    const { calls, context } = makeContext(
      [{ operation: "list", baseId: "bas_1", returnAll: true, status: "archived" }],
      () => ({ records: [], nextCursor: null }),
    );
    await node.execute.call(context as never);
    expect(calls[0]?.qs?.status).toBe("archived");
  });
});

describe("execute — get", () => {
  it("selects by record ID", async () => {
    const { calls, context } = makeContext(
      [{ operation: "get", baseId: "bas_1", selectBy: "id", recordId: "rec_1" }],
      () => ({ id: "rec_1" }),
    );
    const [rows] = await node.execute.call(context as never);
    expect(calls[0]?.path).toBe("/api/v1/records/get");
    expect(calls[0]?.qs).toEqual({ recordId: "rec_1" });
    expect(rows[0]?.json).toEqual({ id: "rec_1" });
  });

  it("selects by field value, scoped to the Base", async () => {
    const { calls, context } = makeContext(
      [
        {
          operation: "get",
          baseId: "bas_1",
          selectBy: "field",
          fieldSlug: "email",
          fieldValue: "a@b.com",
        },
      ],
      () => ({ id: "rec_2" }),
    );
    await node.execute.call(context as never);
    expect(calls[0]?.qs).toEqual({ baseId: "bas_1", fieldSlug: "email", valueText: "a@b.com" });
  });
});

describe("execute — create", () => {
  it("sends the resourceMapper's mapped values as fields", async () => {
    const { calls, context } = makeContext(
      [
        {
          operation: "create",
          baseId: "bas_1",
          fields: { value: { name: "Ada", score: 90 } },
          message: "from n8n",
          autoMerge: true,
        },
      ],
      () => ({ materialized: true, id: "rec_new" }),
    );
    const [rows] = await node.execute.call(context as never);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/api/v1/bases/bas_1/change-requests");
    expect(calls[0]?.body).toEqual({
      fields: { name: "Ada", score: 90 },
      message: "from n8n",
      autoMerge: true,
    });
    expect(rows[0]?.json).toEqual({ materialized: true, id: "rec_new" });
  });

  it("falls back to a default message when none is given", async () => {
    const { calls, context } = makeContext(
      [
        {
          operation: "create",
          baseId: "bas_1",
          fields: { value: {} },
          message: "",
          autoMerge: true,
        },
      ],
      () => ({}),
    );
    await node.execute.call(context as never);
    expect((calls[0]?.body as { message: string }).message).toBe("Created via n8n");
  });

  it("sends an empty fields object rather than crashing when nothing was mapped", async () => {
    const { calls, context } = makeContext(
      [
        {
          operation: "create",
          baseId: "bas_1",
          fields: { value: null },
          message: "x",
          autoMerge: true,
        },
      ],
      () => ({}),
    );
    await node.execute.call(context as never);
    expect((calls[0]?.body as { fields: unknown }).fields).toEqual({});
  });
});

describe("execute — update", () => {
  it("posts to the record's own change-requests endpoint with operation: update", async () => {
    const { calls, context } = makeContext(
      [
        {
          operation: "update",
          baseId: "bas_1",
          recordId: "rec_1",
          fields: { value: { score: 42 } },
          message: "edit",
          autoMerge: true,
        },
      ],
      () => ({ materialized: true, id: "rec_1" }),
    );
    await node.execute.call(context as never);
    expect(calls[0]?.path).toBe("/api/v1/records/rec_1/change-requests");
    expect(calls[0]?.body).toEqual({
      operation: "update",
      fields: { score: 42 },
      message: "edit",
      autoMerge: true,
    });
  });
});

describe("execute — error handling", () => {
  it("propagates a request failure when continueOnFail is off", async () => {
    const { context } = makeContext(
      [{ operation: "get", baseId: "bas_1", selectBy: "id", recordId: "x" }],
      () => {
        throw new Error("boom");
      },
    );
    await expect(node.execute.call(context as never)).rejects.toThrow("boom");
  });

  it("turns a failure into an error row when continueOnFail is on, and keeps processing later items", async () => {
    const { context } = makeContext(
      [
        { operation: "get", baseId: "bas_1", selectBy: "id", recordId: "bad" },
        { operation: "get", baseId: "bas_1", selectBy: "id", recordId: "good" },
      ],
      (call) => {
        if ((call.qs as { recordId?: string })?.recordId === "bad") throw new Error("not found");
        return { id: "good" };
      },
    );
    (context as unknown as { continueOnFail: () => boolean }).continueOnFail = () => true;
    const [rows] = await node.execute.call(context as never);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.json).toEqual({ error: "not found" });
    expect(rows[1]?.json).toEqual({ id: "good" });
  });
});

describe("execute — multiple input items", () => {
  it("processes each item independently, in order", async () => {
    const { calls, context } = makeContext(
      [
        { operation: "get", baseId: "bas_1", selectBy: "id", recordId: "a" },
        { operation: "get", baseId: "bas_1", selectBy: "id", recordId: "b" },
      ],
      (call) => ({ id: (call.qs as { recordId?: string })?.recordId }),
    );
    const [rows] = await node.execute.call(context as never);
    expect(calls).toHaveLength(2);
    expect(rows.map((r) => r.json)).toEqual([{ id: "a" }, { id: "b" }]);
  });
});
