/* eslint-disable n8n-nodes-base/node-param-display-name-miscased --
   The { name, value } pairs below are ASSERTION DATA: the exact options the
   loader returns for real Bases, slug casing and all. They are not UI parameter
   definitions, and title-casing them would make the tests assert something the
   API never returns. */
import { describe, expect, it, vi } from "vitest";
import { busabaseApiRequest, getBaseFields, getBases } from "./GenericFunctions";

/**
 * Logic-level tests: they mock `helpers.httpRequestWithAuthentication` and
 * `getCredentials` rather than hit a real server, so what they prove is that
 * this module builds the right request and parses the right response — not
 * that Busabase actually answers that way. That half was verified separately
 * against a real, live `next dev` server (see the changelog for this PR); it
 * is not repeated here because a live-server dependency does not belong in a
 * suite that runs in CI.
 */

const makeContext = (response: unknown) => {
  const httpRequestWithAuthentication = vi.fn().mockResolvedValue(response);
  const context = {
    getCredentials: vi.fn().mockResolvedValue({ baseUrl: "https://busabase.example" }),
    helpers: { httpRequestWithAuthentication },
  };
  return { context, httpRequestWithAuthentication };
};

describe("busabaseApiRequest", () => {
  it("builds the URL under /api/v1 and strips a trailing slash from baseUrl", async () => {
    const { context, httpRequestWithAuthentication } = makeContext({ ok: true });
    const contextWithTrailingSlash = {
      ...context,
      getCredentials: vi.fn().mockResolvedValue({ baseUrl: "https://busabase.example/" }),
    };
    await busabaseApiRequest.call(contextWithTrailingSlash as never, "GET", "/records");
    expect(httpRequestWithAuthentication).toHaveBeenCalledWith(
      "busabaseApi",
      expect.objectContaining({ url: "https://busabase.example/api/v1/records", method: "GET" }),
    );
  });

  it("passes body and query string through untouched", async () => {
    const { context, httpRequestWithAuthentication } = makeContext({});
    await busabaseApiRequest.call(
      context as never,
      "POST",
      "/bases/bas_1/change-requests",
      { fields: { name: "Ada" } },
      { limit: 50 },
    );
    expect(httpRequestWithAuthentication).toHaveBeenCalledWith(
      "busabaseApi",
      expect.objectContaining({
        body: { fields: { name: "Ada" } },
        qs: { limit: 50 },
      }),
    );
  });

  it("authenticates via the busabaseApi credential type", async () => {
    const { context, httpRequestWithAuthentication } = makeContext({});
    await busabaseApiRequest.call(context as never, "GET", "/records");
    expect(httpRequestWithAuthentication.mock.calls[0]?.[0]).toBe("busabaseApi");
  });
});

describe("getBases", () => {
  it("maps id/slug/name into loadOptions entries", async () => {
    const { context } = makeContext([
      { id: "bas_1", slug: "contacts", name: "Contacts" },
      { id: "bas_2", slug: "orders", name: "Orders" },
    ]);
    const options = await getBases.call(context as never);
    // Not UI parameter definitions — these are the exact { name, value } pairs
    // the loader returns for real Bases, slug casing included.
    expect(options).toEqual([
      { name: "Contacts (contacts)", value: "bas_1" },
      { name: "Orders (orders)", value: "bas_2" },
    ]);
  });

  it("returns an empty list rather than throwing when the space has no Bases", async () => {
    const { context } = makeContext([]);
    expect(await getBases.call(context as never)).toEqual([]);
  });
});

describe("getBaseFields", () => {
  const contextFor = (baseId: string, fieldsResponse: unknown) => {
    const { context } = makeContext({ fields: fieldsResponse });
    return {
      ...context,
      getNodeParameter: vi.fn().mockReturnValue(baseId),
    };
  };

  it("prompts to pick a Base first when none is selected yet", async () => {
    const context = contextFor("", []);
    const result = await getBaseFields.call(context as never);
    expect(result.fields).toEqual([]);
    expect(result.emptyFieldsNotice).toMatch(/select a base/i);
  });

  it.each([
    ["number", "number"],
    ["auto_number", "number"],
    ["checkbox", "boolean"],
    ["date", "dateTime"],
    ["created_time", "dateTime"],
    ["url", "url"],
    ["text", "string"],
    ["relation", "string"], // no direct n8n equivalent — falls back to string
  ])("maps Busabase field type %s -> resourceMapper type %s", async (busabaseType, n8nType) => {
    const context = contextFor("bas_1", [
      { slug: "f", name: "F", type: busabaseType, required: false, options: {} },
    ]);
    const result = await getBaseFields.call(context as never);
    expect(result.fields[0]?.type).toBe(n8nType);
  });

  it("populates select options with choice NAME as both label and value", async () => {
    const context = contextFor("bas_1", [
      {
        slug: "stage",
        name: "Stage",
        type: "select",
        required: false,
        options: {
          choices: [
            { id: "c1", name: "To do" },
            { id: "c2", name: "Done" },
          ],
        },
      },
    ]);
    const result = await getBaseFields.call(context as never);
    // choice NAME, not id — matches what a real record's headCommit.payload
    // reads back (verified against live data while building drizzle-busabase),
    // and Busabase's own `choiceMatches` accepts either, so this round-trips.
    expect(result.fields[0]?.options).toEqual([
      { name: "To do", value: "To do" },
      { name: "Done", value: "Done" },
    ]);
  });

  it("leaves options undefined for a field with no choices", async () => {
    const context = contextFor("bas_1", [
      { slug: "name", name: "Name", type: "text", required: false, options: {} },
    ]);
    const result = await getBaseFields.call(context as never);
    expect(result.fields[0]?.options).toBeUndefined();
  });
});
