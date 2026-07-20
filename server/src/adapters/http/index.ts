import type { AdapterConfigSchema, ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "url",
        label: "Webhook URL",
        type: "text",
        required: true,
        hint: "Absolute http(s) endpoint invoked for each heartbeat.",
      },
      {
        key: "controllerToken",
        label: "Controller token",
        type: "text",
        hint: "Optional bearer token generated as the Authorization header at runtime. Stored as a Paperclip secret reference.",
        meta: { secret: true },
      },
      {
        key: "method",
        label: "HTTP method",
        type: "text",
        default: "POST",
      },
      {
        key: "headers",
        label: "Extra headers",
        type: "textarea",
        hint: "Optional JSON object of nonsecret headers. Authorization, cookies, API keys, tokens, and other secret-like headers are rejected.",
      },
      {
        key: "payloadTemplate",
        label: "Payload template",
        type: "textarea",
        hint: "Optional JSON object merged into the heartbeat request body.",
      },
      {
        key: "timeoutMs",
        label: "Timeout milliseconds",
        type: "number",
        default: 0,
        hint: "Set to zero to disable the adapter request timeout.",
      },
    ],
  };
}

export const httpAdapter: ServerAdapterModule = {
  type: "http",
  execute,
  testEnvironment,
  getConfigSchema,
  models: [],
  agentConfigurationDoc: `# http agent configuration

Adapter: http

Core fields:
- url (string, required): endpoint to invoke
- method (string, optional): HTTP method, default POST
- controllerToken (secret, optional): runtime-resolved bearer token
- headers (object, optional): nonsecret request headers
- payloadTemplate (object, optional): JSON payload template
- timeoutMs (number, optional): request timeout in milliseconds
`,
};
