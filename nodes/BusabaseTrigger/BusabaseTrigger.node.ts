import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  IDataObject,
  IHookFunctions,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
} from "n8n-workflow";
import { NodeConnectionTypes, NodeOperationError } from "n8n-workflow";
import { busabaseApiRequest, getBases } from "../Busabase/GenericFunctions";

/**
 * An instant trigger, backed by Busabase's own webhook push
 * (`packages/busabase-core/src/domains/webhook/logic/dispatch.ts`) rather
 * than polling: `create()` registers a `webhook`-kind rule pointing at this
 * node's n8n-hosted URL, `delete()` removes it on deactivation, and
 * `webhook()` verifies each delivery's HMAC-SHA256 signature before letting
 * it start a workflow.
 *
 * Verification is HMAC-over-the-raw-body — the same mechanism (and the same
 * reason) n8n's own GitHub/Stripe/Shopify trigger nodes use: `req.rawBody`
 * exists specifically so a trigger node can check a signature against the
 * exact bytes the sender signed, since re-serializing the parsed JSON body is
 * not guaranteed to reproduce it byte-for-byte. If `rawBody` is unavailable
 * for any reason, the delivery is rejected rather than falling back to a
 * reconstructed body — a fallback there would let a verification "pass" on
 * bytes that were never actually checked.
 */
interface BusabaseWebhookStaticData extends IDataObject {
  webhookRuleId?: string;
  secret?: string;
}

const EVENT_TYPE_BY_PARAMETER: Record<string, string> = {
  new: "record.created",
  updated: "record.updated",
};

export class BusabaseTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Busabase Trigger",
    name: "busabaseTrigger",
    icon: "file:busabase.svg",
    group: ["trigger"],
    version: 1,
    subtitle: '={{$parameter["event"]}}',
    description: "Starts the workflow when a record is created or updated in a Busabase Base",
    defaults: { name: "Busabase Trigger" },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "busabaseApi", required: true }],
    webhooks: [
      {
        name: "default",
        httpMethod: "POST",
        responseMode: "onReceived",
        path: "webhook",
      },
    ],
    properties: [
      {
        displayName: "Event",
        name: "event",
        type: "options",
        noDataExpression: true,
        options: [
          { name: "New Record", value: "new" },
          { name: "Updated Record", value: "updated" },
        ],
        default: "new",
      },
      {
        displayName: "Base Name or ID",
        name: "baseId",
        type: "options",
        typeOptions: { loadOptionsMethod: "getBases" },
        default: "",
        description:
          'Restrict to one Base. Leave empty to fire for every Base in the space. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
      },
    ],
  };

  methods = { loadOptions: { getBases } };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData("node") as BusabaseWebhookStaticData;
        if (!data.webhookRuleId) return false;
        try {
          await busabaseApiRequest.call(this, "GET", `/webhooks/${data.webhookRuleId}`);
          return true;
        } catch {
          // The rule was deleted out-of-band (e.g. from the Busabase UI) —
          // treat as absent so `create()` runs and re-registers it.
          delete data.webhookRuleId;
          delete data.secret;
          return false;
        }
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const targetUrl = this.getNodeWebhookUrl("default");
        if (!targetUrl) {
          throw new NodeOperationError(
            this.getNode(),
            "n8n did not provide a webhook URL to register with Busabase.",
          );
        }
        const eventParameter = this.getNodeParameter("event") as string;
        const baseId = (this.getNodeParameter("baseId") as string) || null;
        const secret = randomBytes(32).toString("hex");

        const rule = (await busabaseApiRequest.call(this, "POST", "/webhooks", {
          name: `n8n: ${this.getWorkflow().name ?? this.getNode().name}`,
          eventType: EVENT_TYPE_BY_PARAMETER[eventParameter],
          baseId,
          enabled: true,
          actionKind: "webhook",
          config: { targetUrl, secret },
        })) as unknown as { id: string };

        const data = this.getWorkflowStaticData("node") as BusabaseWebhookStaticData;
        data.webhookRuleId = rule.id;
        data.secret = secret;
        return true;
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData("node") as BusabaseWebhookStaticData;
        if (!data.webhookRuleId) return true;
        try {
          await busabaseApiRequest.call(this, "DELETE", `/webhooks/${data.webhookRuleId}`);
        } catch (error) {
          // Deliberately non-fatal: deactivating a workflow must not get stuck
          // because the rule was already gone (e.g. the Base was deleted,
          // cascading the rule with it). But it is logged rather than
          // swallowed, so "already gone" is distinguishable from "the API is
          // down" when someone goes looking.
          this.logger.warn(
            `Busabase Trigger: could not delete webhook rule ${data.webhookRuleId} — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        delete data.webhookRuleId;
        delete data.secret;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const data = this.getWorkflowStaticData("node") as BusabaseWebhookStaticData;
    const secret = data.secret;
    const request = this.getRequestObject();
    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
    const signature = this.getHeaderData()["x-busabase-signature"];

    const verified =
      typeof secret === "string" &&
      Buffer.isBuffer(rawBody) &&
      typeof signature === "string" &&
      timingSafeEqualHex(createHmac("sha256", secret).update(rawBody).digest("hex"), signature);

    if (!verified) {
      this.getResponseObject().status(401).send("invalid or missing signature");
      return { noWebhookResponse: true };
    }

    return { workflowData: [this.helpers.returnJsonArray([this.getBodyData()])] };
  }
}

/** `timingSafeEqual` throws on mismatched lengths instead of returning false. */
const timingSafeEqualHex = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};
