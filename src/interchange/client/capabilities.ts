import { type } from "arktype";
import { getAppHostRequirements } from "../../extensions/apps.js";
import { supportedHostExtensions } from "../../extensions/maturity.js";
import { createElicitationRuntime } from "../../extensions/elicitation.js";
import type { McpClientOptions } from "../../client.js";
import {
  MCP_EXT_TASKS,
  MCP_EXT_UI,
  MCP_EXT_SKILLS,
} from "../../protocol/index.js";
import type { McpHostServices } from "./contracts.js";

// Host configuration boundary, not an MCP wire schema. Support is explicitly
// declared by the embedding host; we do not implement or certify its renderer.
const AppsHostSchema = type({
  bridge: { mount: "Function", call: "Function" },
  support: {
    sandboxRenderer: "boolean",
    cspEnforcement: "boolean",
    authenticatedBridge: "boolean",
  },
});

export function assertHostExtensions(
  extensions: readonly string[] = [],
  host: McpHostServices = {},
): void {
  if (extensions.includes(MCP_EXT_TASKS) && host.adoptTask === undefined)
    throw new Error("MCP tasks require a host adoption and delivery service");
  if (extensions.includes(MCP_EXT_UI)) {
    const apps = AppsHostSchema(host.apps);
    if (
      apps instanceof type.errors ||
      !supportedHostExtensions({ apps: apps.support }).includes(MCP_EXT_UI) ||
      typeof host.presentResult !== "function"
    ) {
      throw new Error(
        "MCP Apps require an explicit host bridge, sandbox renderer, CSP enforcement, authenticated bridge, and presentation service",
      );
    }
  }
  if (extensions.includes(MCP_EXT_SKILLS))
    throw new Error(
      "Use createMcpSkillConsumer for skills; tool factories do not activate skills",
    );
}

export function hostClientOptions(
  host: McpHostServices | undefined,
  extensions: readonly string[] = [],
): Pick<McpClientOptions, "clientCapabilities"> {
  assertHostExtensions(extensions, host);
  const elicitation =
    host?.elicitation === undefined
      ? {}
      : createElicitationRuntime(host.elicitation).capabilities;
  const hasElicitation = Object.keys(elicitation).length > 0;
  if (!hasElicitation && !extensions.includes(MCP_EXT_UI)) return {};
  return {
    clientCapabilities: {
      ...(hasElicitation ? { elicitation } : {}),
      ...(extensions.length === 0
        ? {}
        : {
            extensions: Object.fromEntries(
              extensions.map((id) => [
                id,
                id === MCP_EXT_UI
                  ? { mimeTypes: [getAppHostRequirements().mimeType] }
                  : {},
              ]),
            ),
          }),
    },
  };
}
