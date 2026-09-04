import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from "n8n-workflow";

/**
 * Busabase's REST API is Bearer-token auth (`Authorization: Bearer <key>`,
 * `apps/busabase-sdk/src/client.ts`) — the same header shape for a static API
 * key or an OAuth access token. This credential covers the API key path: it
 * is the zero-custom-code integration, whereas Busabase's OAuth (PKCE, no
 * client secret, non-standard `resource` parameter, and a shared client that
 * only accepts loopback redirect URIs) does not map onto a generic OAuth2
 * credential type without dynamic client registration glue this package does
 * not implement.
 */
export class BusabaseApi implements ICredentialType {
  name = "busabaseApi";
  displayName = "Busabase API";
  documentationUrl = "https://busabase.com/docs";

  properties: INodeProperties[] = [
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "https://busabase.com",
      description:
        "Root URL of your Busabase server or Busabase Cloud space — no trailing /api/v1.",
    },
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      description: "A Busabase API key. Not required against a local, unauthenticated OSS server.",
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: {
        Authorization: "=Bearer {{$credentials.apiKey}}",
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: "={{$credentials.baseUrl}}",
      url: "/api/health",
    },
  };
}
