import { expect, test } from "bun:test";
import { createAppHostBridge } from "../../extensions/apps.js";
import { mcpTools } from "../../tool.js";
import { mcpServers } from "../../sidecar-bundle.js";
import { assertHostExtensions, hostClientOptions } from "./capabilities.js";
import type { McpHostServices } from "./contracts.js";

const ui = ["io.modelcontextprotocol/ui"];
// Test-only host. Production hosts must implement these callbacks and support
// obligations; the library does not provide a renderer.
const bridge = createAppHostBridge({
  async mount() {
    return { async close() {} };
  },
  async authorizeTool() {},
  async callTool() {
    return {};
  },
});
const support = {
  sandboxRenderer: true,
  cspEnforcement: true,
  authenticatedBridge: true,
};
const presentResult = async () => {};

for (const [name, apps] of [
  ["presentation alone", undefined],
  [
    "missing sandbox",
    { bridge, support: { ...support, sandboxRenderer: false } },
  ],
  ["missing CSP", { bridge, support: { ...support, cspEnforcement: false } }],
  [
    "unauthenticated bridge",
    { bridge, support: { ...support, authenticatedBridge: false } },
  ],
  ["missing bridge", { support }],
  ["missing mount callback", { support, bridge: { call: bridge.call } }],
  ["missing call callback", { support, bridge: { mount: bridge.mount } }],
  ["unknown support", { bridge }],
] as const) {
  test(`Apps opt-in rejects ${name} before either factory can advertise`, async () => {
    // Exercise malformed runtime config as well as correctly typed false claims.
    const host = {
      presentResult,
      ...(apps === undefined ? {} : { apps }),
    } as unknown as McpHostServices;
    expect(() => mcpServers({ servers: [], extensions: ui, host })).toThrow(
      "Apps",
    );
    await expect(
      mcpTools({ servers: [], extensions: ui, host }),
    ).rejects.toThrow("Apps");
    expect(() => hostClientOptions(host, ui)).toThrow("Apps");
  });
}

test("explicit host Apps support and bridge permit UI with form capability", () => {
  const host: McpHostServices = {
    apps: { bridge, support },
    presentResult,
    elicitation: { form: async () => ({ action: "decline" }) },
  };
  expect(() => assertHostExtensions(ui, host)).not.toThrow();
  expect(hostClientOptions(host, ui)).toEqual({
    clientCapabilities: {
      elicitation: { form: {} },
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    },
  });
});

test("metadata-only presentation without UI opt-in never advertises Apps", () => {
  expect(hostClientOptions({ presentResult })).toEqual({});
  expect(() =>
    mcpServers({ servers: [], host: { presentResult } }),
  ).not.toThrow();
});

test("Apps without elicitation still requires validated support and advertises only UI", () => {
  expect(
    hostClientOptions({ apps: { bridge, support }, presentResult }, ui),
  ).toEqual({
    clientCapabilities: {
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    },
  });
  expect(() => assertHostExtensions(ui, { apps: { bridge, support } })).toThrow(
    "Apps",
  );
  expect(
    hostClientOptions({ apps: { bridge, support }, presentResult }),
  ).toEqual({});
});
