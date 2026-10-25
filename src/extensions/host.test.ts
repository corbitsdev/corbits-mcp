import { expect, test } from "bun:test";
import {
  assertAppToolCall,
  createAppHostBridge,
  getAppHostRequirements,
  isToolVisibleToModel,
} from "./apps.js";
import { createElicitationRuntime } from "./elicitation.js";
import { extensionMaturity, supportedHostExtensions } from "./maturity.js";
test("released maturity preserves wire IDs and absent host support stays absent", () => {
  expect(extensionMaturity.tasks.maturity).toBe("stable");
  expect(extensionMaturity.skills.id).toBe("io.modelcontextprotocol/skills");
  expect(extensionMaturity.apps.extensionRevision).toBe("2026-01-26");
  expect(supportedHostExtensions({})).toEqual([]);
  expect(
    supportedHostExtensions({
      apps: {
        sandboxRenderer: false,
        cspEnforcement: true,
        authenticatedBridge: true,
      },
    }),
  ).toEqual([]);
});
test("Apps visibility and connection boundaries apply independently of transport", async () => {
  expect(isToolVisibleToModel()).toBe(true);
  expect(isToolVisibleToModel({ visibility: ["app"] })).toBe(false);
  expect(() =>
    assertAppToolCall({ appServerId: "a", targetServerId: "b" }),
  ).toThrow("Cross-server");
  expect(() =>
    assertAppToolCall({
      appServerId: "a",
      targetServerId: "a",
      tool: { visibility: ["model"] },
    }),
  ).toThrow("not app-callable");
  const calls: string[] = [];
  const bridge = createAppHostBridge({
    async mount(_resource, requirements) {
      expect(requirements.rendererProvided).toBe(false);
      return { async close() {} };
    },
    async authorizeTool() {
      calls.push("authorize");
    },
    async callTool() {
      calls.push("call");
      return "ok";
    },
  });
  await bridge.call({
    appServerId: "a",
    targetServerId: "a",
    name: "tool",
    arguments: {},
  });
  expect(calls).toEqual(["authorize", "call"]);
  await expect(
    bridge.mount({
      uri: "https://unsafe",
      mimeType: "text/html",
      text: "<html/>",
    }),
  ).rejects.toThrow("Unsupported");
  expect(getAppHostRequirements().defaults.connectSrc).toBe("'none'");
});
test("elicitation requires real host services and validates accepted form content", async () => {
  const form = {
    method: "elicitation/create" as const,
    params: {
      message: "Name",
      requestedSchema: {
        type: "object" as const,
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  };
  expect(createElicitationRuntime({}).capabilities).toEqual({});
  await expect(
    createElicitationRuntime({}).respond({ q: form }),
  ).rejects.toThrow("host unavailable");
  const runtime = createElicitationRuntime({
    async form() {
      return { action: "accept", content: { name: "Ada" } };
    },
  });
  expect((await runtime.respond({ q: form })).q).toEqual({
    action: "accept",
    content: { name: "Ada" },
  });
  await expect(
    createElicitationRuntime({
      async form() {
        return { action: "accept", content: { name: 4 } };
      },
    }).respond({ q: form }),
  ).rejects.toThrow();
  await expect(
    runtime.respond({ q: { method: "roots/list" } }),
  ).rejects.toThrow("unsupported");
});
test("URL elicitation is explicit consent, never automatic acceptance or credential-bearing navigation", async () => {
  const request = {
    method: "elicitation/create" as const,
    params: {
      mode: "url" as const,
      message: "Visit",
      url: "https://example.com/consent",
    },
  };
  const runtime = createElicitationRuntime({
    async url() {
      return { action: "decline" };
    },
  });
  expect((await runtime.respond({ q: request })).q).toEqual({
    action: "decline",
  });
  await expect(
    runtime.respond({
      q: {
        ...request,
        params: { ...request.params, url: "https://user:secret@example.com" },
      },
    }),
  ).rejects.toThrow("Unsafe");
  await expect(
    createElicitationRuntime({
      async url() {
        return { action: "accept", content: { token: "no" } };
      },
    }).respond({ q: request }),
  ).rejects.toThrow("cannot return form content");
});
