import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

const SENSITIVE_HEADER_NAME_RE =
  /(authorization|cookie|api[-_]?key|token|secret|password|passwd|credential|jwt|private[-_]?key)/i;
const INVALID_HEADER_VALUE_CHAR_RE = /[\u0000-\u001f\u007f]/;

class SafeHttpAdapterError extends Error {}

function buildRequestHeaders(
  configuredHeaders: unknown,
  controllerToken: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  for (const [name, value] of Object.entries(parseObject(configuredHeaders))) {
    if (SENSITIVE_HEADER_NAME_RE.test(name)) {
      throw new SafeHttpAdapterError(
        "HTTP adapter config.headers cannot include authorization, cookie, API key, token, secret, password, credential, or JWT headers; use controllerToken for bearer authentication.",
      );
    }
    headers[name] = String(value);
  }

  if (controllerToken) {
    if (INVALID_HEADER_VALUE_CHAR_RE.test(controllerToken)) {
      throw new SafeHttpAdapterError("HTTP adapter controllerToken contains invalid header characters.");
    }
    headers.authorization = `Bearer ${controllerToken}`;
  }

  return headers;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const controllerToken = asString(config.controllerToken, "").trim();
  const headers = buildRequestHeaders(config.headers, controllerToken);
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = { ...payloadTemplate, agentId: agent.id, runId, context };

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(body),
      ...(controllerToken ? { redirect: "error" as const } : {}),
      ...(timer ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      throw new SafeHttpAdapterError(`HTTP invoke failed with status ${res.status}`);
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `HTTP ${method} ${url}`,
    };
  } catch (err) {
    if (timer && err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `HTTP ${method} ${url} timed out after ${timeoutMs}ms`,
        errorCode: "timeout",
      };
    }
    if (err instanceof SafeHttpAdapterError) throw err;
    throw new SafeHttpAdapterError("HTTP invoke failed before receiving a response");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
