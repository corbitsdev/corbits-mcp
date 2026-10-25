/** Remote MCP consumption through actual Interchange tool and host contracts. */
export {
  mcpTools,
  type McpServerConfig,
  type McpToolsEnv,
  type McpToolsOptions,
} from "../tool.js";
export {
  mcpServers,
  SIDECAR_BUNDLE_ID,
  shapeMcpContent,
  type McpBoundServer,
  type McpServersConfig,
  type McpServersEnv,
} from "../sidecar-bundle.js";
export type {
  McpHostContext,
  McpHostServices,
  McpTaskControls,
} from "./client/contracts.js";
export {
  createCatalogGuard,
  type McpCatalogSnapshot,
} from "./client/catalog.js";
export { createMcpSkillConsumer } from "./client/skills.js";

export {
  createSkillLoader,
  parseSkillFrontmatter,
  SKILL_LIMITS,
} from "../extensions/skills/index.js";
export type * from "../extensions/skills/contracts.js";
