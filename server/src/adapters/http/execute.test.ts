import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import { getConfigSchema } from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http adapter execute", () => {
  const baseContext = {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Agent",
      adapterType: "http",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    context: {},
    onLog: async () => {},
  };

  it("declares controllerToken as an optional schema secret", () => {
    const schema = getConfigSchema();
    const tokenField = schema.fields.find((field) => field.key === "controllerToken");

    expect(tokenField).toMatchObject({
      key: "controllerToken",
      meta: { secret: true },
    });
    expect(tokenField?.required).not.toBe(true);
  });

  it("sends a resolved controller token only as a synthesized bearer header", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const controllerToken = "controller-secret-value";

    const result = await execute({
      ...baseContext,
      config: {
        url: "https://example.test/webhook",
        controllerToken,
        headers: { "x-request-source": "paperclip" },
      },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toEqual({
      "content-type": "application/json",
      "x-request-source": "paperclip",
      authorization: `Bearer ${controllerToken}`,
    });
    expect(request.body).not.toContain(controllerToken);
    expect(result.summary).not.toContain(controllerToken);
  });

  it.each([
    "Authorization",
    "proxy-authorization",
    "Cookie",
    "x-api-key",
    "x-controller-token",
    "x-client-secret",
  ])("rejects sensitive configured header %s without making a request", async (headerName) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(execute({
      ...baseContext,
      config: {
        url: "https://example.test/webhook",
        controllerToken: "resolved-controller-token",
        headers: { [headerName]: "plaintext-value" },
      },
    })).rejects.toThrow("config.headers cannot include");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expose the controller token through downstream request errors", async () => {
    const controllerToken = "controller-token-must-not-leak";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`downstream error included ${controllerToken}`);
      }),
    );

    let error: unknown;
    try {
      await execute({
        ...baseContext,
        config: {
          url: "https://example.test/webhook",
          controllerToken,
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("HTTP invoke failed before receiving a response");
    expect((error as Error).message).not.toContain(controllerToken);
  });

  it("reports configured request timeout as timed_out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })),
    );

    const result = await execute({
      ...baseContext,
      config: {
        url: "https://example.test/webhook",
        controllerToken: "timeout-controller-token",
        timeoutMs: 1,
      },
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 1ms");
    expect(result.errorMessage).not.toContain("timeout-controller-token");
  });
});
