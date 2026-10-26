import { McpError } from "./errors.js";
import type { McpValidationContext, McpExtensionSettings } from "./types.js";
export const MCP_EXT_TASKS = "io.modelcontextprotocol/tasks";
export const MCP_EXT_SKILLS = "io.modelcontextprotocol/skills";
export const MCP_EXT_UI = "io.modelcontextprotocol/ui";
export const MCP_EXTENSIONS = {
  [MCP_EXT_TASKS]: {
    id: MCP_EXT_TASKS,
    coreRevision: "2026-07-28",
    extensionRevision: "2026-07-28",
    sourceCommit: "b3d28aceaa6d49f5f92258e3d06b61ad6f111e84",
    maturity: "stable",
    enabledByDefault: false,
  },
  [MCP_EXT_SKILLS]: {
    id: MCP_EXT_SKILLS,
    coreRevision: "2026-07-28",
    extensionRevision: "stable",
    sourceCommit: "c1aa87e4c381c82b99aa37471d0eae4ab50f9985",
    maturity: "stable",
    enabledByDefault: false,
  },
  [MCP_EXT_UI]: {
    id: MCP_EXT_UI,
    coreRevision: "2026-07-28",
    extensionRevision: "2026-01-26",
    sourceCommit: "266a9e3b70dbd4a4f0546dda95da2a2c1a8be4b7",
    maturity: "released",
    enabledByDefault: false,
  },
} as const;
export function extensionEnabled(
  context: McpValidationContext,
  id: string,
): boolean {
  const extensions = context.extensions;
  if (extensions === undefined) return false;
  return Array.isArray(extensions)
    ? extensions.includes(id)
    : Object.hasOwn(extensions, id);
}
export function validateExtensionSettings(
  settings: McpExtensionSettings,
): McpExtensionSettings {
  for (const [id, value] of Object.entries(settings)) {
    if (!Object.hasOwn(MCP_EXTENSIONS, id))
      throw new McpError(`unsupported extension ${id}`);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new McpError(`invalid settings for ${id}`);
    const allowed =
      id === MCP_EXT_SKILLS
        ? ["directoryRead"]
        : id === MCP_EXT_UI
          ? ["mimeTypes"]
          : [];
    if (Object.keys(value).some((key) => !allowed.includes(key)))
      throw new McpError(`unsupported settings for ${id}`);
    if (
      value.directoryRead !== undefined &&
      typeof value.directoryRead !== "boolean"
    )
      throw new McpError("directoryRead must be boolean");
    if (
      value.mimeTypes !== undefined &&
      (!Array.isArray(value.mimeTypes) ||
        !value.mimeTypes.every((v) => typeof v === "string"))
    )
      throw new McpError("mimeTypes must be strings");
  }
  return settings;
}
/** Negotiate only explicitly requested, known extensions advertised by the peer. */
export function negotiateExtensions(
  requested: McpExtensionSettings,
  peer: McpExtensionSettings,
): McpExtensionSettings {
  validateExtensionSettings(requested);
  const result: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [id, settings] of Object.entries(requested)) {
    if (!Object.hasOwn(peer, id)) continue;
    const remote = peer[id];
    if (remote === undefined) continue;
    validateExtensionSettings({ [id]: remote });
    if (id === MCP_EXT_UI) {
      const localTypes = settings.mimeTypes as readonly string[] | undefined;
      const remoteTypes = remote.mimeTypes as readonly string[] | undefined;
      result[id] = {
        mimeTypes: (localTypes ?? ["text/html;profile=mcp-app"]).filter(
          (mime) =>
            (remoteTypes ?? ["text/html;profile=mcp-app"]).includes(mime),
        ),
      };
    } else if (id === MCP_EXT_SKILLS)
      result[id] = { directoryRead: remote.directoryRead === true };
    else result[id] = {};
  }
  return result;
}
