// Server-only entry point: the hub-hosted MCP discovery mount. The root and
// `./sidecar-bundle` entries stay free of `hono` and `@intx/db` so neither a
// browser bundle nor a deployed agent ever reaches them.
export {
  mountMcpDiscovery,
  discoverMcpServer,
  readCredential,
  type McpCredential,
  type McpDiscovery,
  type MountMcpDiscoveryOpts,
} from "./discover.js";
