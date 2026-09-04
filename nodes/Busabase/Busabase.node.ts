import type {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  ResourceMapperFields,
  ResourceMapperValue,
} from "n8n-workflow";
import { NodeConnectionTypes, NodeOperationError } from "n8n-workflow";
import { busabaseApiRequest, getBaseFields, getBases } from "./GenericFunctions";

interface RecordListPage {
  records: IDataObject[];
  nextCursor: string | null;
}

export class Busabase implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Busabase",
    name: "busabase",
    icon: "file:busabase.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: "List, get, create, and update records in a Busabase Base",
    defaults: { name: "Busabase" },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "busabaseApi", required: true }],
    properties: [
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        options: [
          { name: "List", value: "list", action: "List records" },
          { name: "Get", value: "get", action: "Get a record" },
          { name: "Create", value: "create", action: "Create a record" },
          { name: "Update", value: "update", action: "Update a record" },
        ],
        default: "list",
      },
      {
        displayName: "Base",
        name: "baseId",
        type: "options",
        typeOptions: { loadOptionsMethod: "getBases" },
        default: "",
        required: true,
        description:
          "The Base to operate on. On Update this only drives the field-mapping UI below — the API call itself is addressed by Record ID.",
      },

      // ── List ──────────────────────────────────────────────────────────
      {
        displayName: "Return All",
        name: "returnAll",
        type: "boolean",
        default: false,
        displayOptions: { show: { operation: ["list"] } },
      },
      {
        displayName: "Limit",
        name: "limit",
        type: "number",
        typeOptions: { minValue: 1, maxValue: 100 },
        default: 50,
        displayOptions: { show: { operation: ["list"], returnAll: [false] } },
      },
      {
        displayName: "Status",
        name: "status",
        type: "options",
        options: [
          { name: "Active", value: "active" },
          { name: "Archived", value: "archived" },
        ],
        default: "active",
        displayOptions: { show: { operation: ["list"] } },
      },

      // ── Get ───────────────────────────────────────────────────────────
      {
        displayName: "Select By",
        name: "selectBy",
        type: "options",
        options: [
          { name: "Record ID", value: "id" },
          { name: "Field Value", value: "field" },
        ],
        default: "id",
        displayOptions: { show: { operation: ["get"] } },
      },
      {
        displayName: "Field Slug",
        name: "fieldSlug",
        type: "string",
        default: "",
        placeholder: "email",
        description:
          "The field's slug (not its display name) — visible in the Base's field settings.",
        displayOptions: { show: { operation: ["get"], selectBy: ["field"] } },
      },
      {
        displayName: "Field Value",
        name: "fieldValue",
        type: "string",
        default: "",
        description: "Matched by exact value.",
        displayOptions: { show: { operation: ["get"], selectBy: ["field"] } },
      },

      // ── Get / Update: Record ID ──────────────────────────────────────
      {
        displayName: "Record ID",
        name: "recordId",
        type: "string",
        default: "",
        required: true,
        displayOptions: { show: { operation: ["get"], selectBy: ["id"] } },
      },
      {
        displayName: "Record ID",
        name: "recordId",
        type: "string",
        default: "",
        required: true,
        displayOptions: { show: { operation: ["update"] } },
      },

      // ── Create / Update: field mapping ───────────────────────────────
      {
        displayName: "Fields",
        name: "fields",
        type: "resourceMapper",
        default: { mappingMode: "defineBelow", value: null },
        noDataExpression: true,
        typeOptions: {
          loadOptionsDependsOn: ["baseId"],
          resourceMapper: {
            resourceMapperMethod: "getBaseFields",
            mode: "add",
            valuesLabel: "Fields",
            fieldWords: { singular: "field", plural: "fields" },
            addAllFields: true,
            multiKeyMatch: false,
            supportAutoMap: false,
          },
        },
        displayOptions: { show: { operation: ["create", "update"] } },
      },
      {
        displayName: "Message",
        name: "message",
        type: "string",
        default: "",
        placeholder: "Created via n8n",
        description: "Shown to a human reviewer if this change is not auto-merged.",
        displayOptions: { show: { operation: ["create", "update"] } },
      },
      {
        displayName: "Auto-Merge",
        name: "autoMerge",
        type: "boolean",
        default: true,
        description:
          "Whether to apply immediately if the credential has write access, instead of leaving a pending Change Request for review",
        displayOptions: { show: { operation: ["create", "update"] } },
      },
    ],
  };

  methods = {
    loadOptions: { getBases },
    resourceMapping: { getBaseFields },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const operation = this.getNodeParameter("operation", 0) as string;
    const returnData: IDataObject[] = [];

    for (let i = 0; i < items.length; i++) {
      try {
        const baseId = this.getNodeParameter("baseId", i) as string;

        if (operation === "list") {
          const returnAll = this.getNodeParameter("returnAll", i) as boolean;
          const status = this.getNodeParameter("status", i) as string;
          const requestedLimit = returnAll
            ? undefined
            : (this.getNodeParameter("limit", i) as number);
          const records: IDataObject[] = [];
          let cursor: string | undefined;
          do {
            const page = (await busabaseApiRequest.call(this, "GET", "/records", undefined, {
              baseId,
              status,
              limit: Math.min(requestedLimit ?? 100, 100),
              ...(cursor ? { cursor } : {}),
            })) as unknown as RecordListPage;
            records.push(...page.records);
            cursor = page.nextCursor ?? undefined;
            if (!returnAll && records.length >= (requestedLimit ?? Number.POSITIVE_INFINITY)) break;
          } while (cursor);
          returnData.push(...(returnAll ? records : records.slice(0, requestedLimit)));
        } else if (operation === "get") {
          const selectBy = this.getNodeParameter("selectBy", i) as string;
          const qs: IDataObject =
            selectBy === "id"
              ? { recordId: this.getNodeParameter("recordId", i) as string }
              : {
                  baseId,
                  fieldSlug: this.getNodeParameter("fieldSlug", i) as string,
                  valueText: this.getNodeParameter("fieldValue", i) as string,
                };
          returnData.push(
            await busabaseApiRequest.call(this, "GET", "/records/get", undefined, qs),
          );
        } else if (operation === "create") {
          const mapped = this.getNodeParameter("fields", i) as ResourceMapperValue;
          returnData.push(
            await busabaseApiRequest.call(this, "POST", `/bases/${baseId}/change-requests`, {
              fields: mapped.value ?? {},
              message: (this.getNodeParameter("message", i) as string) || "Created via n8n",
              autoMerge: this.getNodeParameter("autoMerge", i) as boolean,
            }),
          );
        } else if (operation === "update") {
          const recordId = this.getNodeParameter("recordId", i) as string;
          const mapped = this.getNodeParameter("fields", i) as ResourceMapperValue;
          returnData.push(
            await busabaseApiRequest.call(this, "POST", `/records/${recordId}/change-requests`, {
              operation: "update",
              fields: mapped.value ?? {},
              message: (this.getNodeParameter("message", i) as string) || "Updated via n8n",
              autoMerge: this.getNodeParameter("autoMerge", i) as boolean,
            }),
          );
        } else {
          throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
        }
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({ error: error instanceof Error ? error.message : String(error) });
          continue;
        }
        throw error;
      }
    }

    return [this.helpers.returnJsonArray(returnData)];
  }
}

// Re-exported so tests can call the loadOptions/resourceMapper methods directly
// without constructing a full node instance.
export const busabaseLoadOptionsMethods = { getBases };
export const busabaseResourceMapperMethods: { getBaseFields: typeof getBaseFields } = {
  getBaseFields,
};
export type { ResourceMapperFields };
