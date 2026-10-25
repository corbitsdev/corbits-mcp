/** Upstream maturity, not transport support or a claim about host deployment. */
import {
  MCP_EXTENSIONS,
  MCP_EXT_TASKS,
  MCP_EXT_SKILLS,
  MCP_EXT_UI,
} from "../protocol/index.js";
export const extensionMaturity = Object.freeze({
  tasks: MCP_EXTENSIONS[MCP_EXT_TASKS],
  skills: MCP_EXTENSIONS[MCP_EXT_SKILLS],
  apps: MCP_EXTENSIONS[MCP_EXT_UI],
});

/** Negotiating a wire extension does not supply a renderer, approvals or durability. */
export function supportedHostExtensions(options: {
  tasks?: {
    durableStore: boolean;
    recoverableExecutor: boolean;
    inputHandler: boolean;
  };
  skills?: {
    verifiedLoader: boolean;
    contextProvenance: boolean;
    executionGate: boolean;
  };
  apps?: {
    sandboxRenderer: boolean;
    cspEnforcement: boolean;
    authenticatedBridge: boolean;
  };
}): string[] {
  const ids: string[] = [];
  if (
    options.tasks?.durableStore === true &&
    options.tasks.recoverableExecutor === true &&
    options.tasks.inputHandler === true
  )
    ids.push(extensionMaturity.tasks.id);
  if (
    options.skills?.verifiedLoader === true &&
    options.skills.contextProvenance === true &&
    options.skills.executionGate === true
  )
    ids.push(extensionMaturity.skills.id);
  if (
    options.apps?.sandboxRenderer === true &&
    options.apps.cspEnforcement === true &&
    options.apps.authenticatedBridge === true
  )
    ids.push(extensionMaturity.apps.id);
  return ids;
}
