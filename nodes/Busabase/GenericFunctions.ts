import type {
  IDataObject,
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestMethods,
  ILoadOptionsFunctions,
  INodePropertyOptions,
  IWebhookFunctions,
  ResourceMapperFields,
} from "n8n-workflow";

/**
 * REST helpers shared by the Busabase node, its dynamic-field/Base pickers,
 * and the trigger node's webhook lifecycle. All three n8n function contexts
 * (`IExecuteFunctions`, `ILoadOptionsFunctions`, `IHookFunctions`) expose the
 * same `helpers.httpRequestWithAuthentication`, which is what actually injects
 * the credential — this file never touches the API key directly.
 *
 * Every function here takes `this` as its first (implicit) parameter rather
 * than closing over a client, so a test can substitute a fake `this` whose
 * `helpers.httpRequestWithAuthentication` calls a real Busabase server via
 * plain `fetch` — exercising this exact request-building and response-parsing
 * code without needing a live n8n instance.
 */

type BusabaseFunctionContext =
  | IExecuteFunctions
  | ILoadOptionsFunctions
  | IHookFunctions
  | IWebhookFunctions;

/**
 * Every REST route lives under `/api/v1` except `/api/health`, which the
 * credential's connection test hits directly — see `BusabaseApi.credentials.ts`.
 *
 * `getCredentials` is called here (to build the URL from `baseUrl`) even
 * though `httpRequestWithAuthentication` will read the SAME credential a
 * second time to inject the `Authorization` header via the type's declared
 * `authenticate` config. That is intentional, not redundant: this function
 * builds a literal URL string, and `IHttpRequestOptions.url` is just that — a
 * plain string, not an n8n `={{ }}` expression, which is only meaningful
 * inside declarative `routing` property definitions, not values built here.
 */
export const busabaseApiRequest = async function (
  this: BusabaseFunctionContext,
  method: IHttpRequestMethods,
  endpoint: string,
  body: IDataObject | undefined = undefined,
  qs: IDataObject | undefined = undefined,
): Promise<IDataObject> {
  const credentials = await this.getCredentials<{ baseUrl: string }>("busabaseApi");
  const options = {
    method,
    url: `${credentials.baseUrl.replace(/\/+$/, "")}/api/v1${endpoint}`,
    ...(body ? { body } : {}),
    ...(qs ? { qs } : {}),
    json: true,
  };
  return (await this.helpers.httpRequestWithAuthentication.call(
    this,
    "busabaseApi",
    options,
  )) as IDataObject;
};

/** Populates the Base picker (`loadOptions`) shown once a credential is selected. */
export const getBases = async function (
  this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
  const bases = (await busabaseApiRequest.call(this, "GET", "/bases")) as unknown as {
    id: string;
    slug: string;
    name: string;
  }[];
  return bases.map((base) => ({ name: `${base.name} (${base.slug})`, value: base.id }));
};

interface BaseFieldVO {
  slug: string;
  name: string;
  type: string;
  required: boolean;
  options: { choices?: { id: string; name: string }[] };
}

/** Busabase field types with no direct n8n `resourceMapper` FieldType — left as `string`. */
const N8N_FIELD_TYPE: Record<string, string> = {
  number: "number",
  auto_number: "number",
  checkbox: "boolean",
  date: "dateTime",
  created_time: "dateTime",
  updated_time: "dateTime",
  url: "url",
};

/**
 * Populates the field-mapping UI (`resourceMapper`) for Create/Update, once a
 * Base is picked. `select`/`multiselect` get their `options` populated from
 * the field's own choice list — Busabase's `choiceMatches` (field-types.ts)
 * accepts either a choice id or its display name, so the choice NAME is used
 * as both label and value: it is what a real record's `headCommit.payload`
 * reads back (see the ORM drivers' verification against live data), so a
 * value copied from a read round-trips through this UI unchanged.
 */
export const getBaseFields = async function (
  this: ILoadOptionsFunctions,
): Promise<ResourceMapperFields> {
  const baseId = this.getNodeParameter("baseId", 0) as string;
  if (!baseId) {
    return { fields: [], emptyFieldsNotice: "Select a Base first." };
  }
  const base = (await busabaseApiRequest.call(this, "GET", `/bases/${baseId}`)) as unknown as {
    fields: BaseFieldVO[];
  };
  return {
    fields: base.fields.map((field) => ({
      id: field.slug,
      displayName: field.name,
      type: (N8N_FIELD_TYPE[field.type] ??
        "string") as ResourceMapperFields["fields"][number]["type"],
      required: false, // Busabase enforces its own required fields server-side; do not duplicate here.
      display: true,
      defaultMatch: false,
      canBeUsedToMatch: false,
      options: field.options.choices?.map((choice) => ({
        name: choice.name,
        value: choice.name,
      })),
    })),
  };
};
