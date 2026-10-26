import type {
  McpUiResourceMeta,
  McpUiToolMeta,
  McpResourceContents,
} from "../protocol/index.js";

/** Metadata helpers only: this package does not render or sandbox HTML. */
export function isToolVisibleToModel(meta?: McpUiToolMeta): boolean {
  return meta?.visibility === undefined || meta.visibility.includes("model");
}
export function assertAppToolCall(options: {
  tool?: McpUiToolMeta;
  appServerId: string;
  targetServerId: string;
}): void {
  if (!options.appServerId || options.appServerId !== options.targetServerId)
    throw new Error("Cross-server app tool call prohibited");
  if (options.tool?.visibility && !options.tool.visibility.includes("app"))
    throw new Error("Tool is not app-callable");
}
export function getAppHostRequirements(meta: McpUiResourceMeta = {}) {
  return {
    rendererProvided: false as const,
    protocolVersion: "2026-01-26" as const,
    mimeType: "text/html;profile=mcp-app" as const,
    sandbox: {
      separateOrigin: true as const,
      proxyRequiredForWebHost: true as const,
      permissions: ["allow-scripts", "allow-same-origin"] as const,
    },
    // These are requested constraints, not a CSP header generator or approval.
    csp: structuredClone(meta.csp ?? {}),
    defaults: {
      connectSrc: "'none'",
      resourceSrc: "'none'",
      frameSrc: "'none'",
      baseUri: "'self'",
    },
    requestedPermissions: structuredClone(meta.permissions ?? {}),
    requestedDomain: meta.domain,
    obligations: [
      "enforce-declared-csp-without-loosening",
      "validate-message-origin-and-source",
      "initialize-before-delivery",
      "authorize-every-tool-call",
      "keep-result-meta-out-of-model-context",
      "user-consent-for-external-navigation",
    ] as const,
  };
}
export interface McpAppHost {
  /** Must implement sandbox, CSP and authenticated message bridge; not a transport flag. */
  mount(
    resource: McpResourceContents,
    requirements: ReturnType<typeof getAppHostRequirements>,
  ): Promise<{ close(): Promise<void> }>;
  authorizeTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<void>;
  callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}
export function createAppHostBridge(host: McpAppHost) {
  return {
    async mount(resource: McpResourceContents, metadata?: McpUiResourceMeta) {
      if (
        !resource.uri.startsWith("ui://") ||
        resource.mimeType !== "text/html;profile=mcp-app"
      )
        throw new Error("Unsupported Apps resource");
      return host.mount(
        structuredClone(resource),
        getAppHostRequirements(metadata),
      );
    },
    async call(options: {
      appServerId: string;
      targetServerId: string;
      name: string;
      arguments: Record<string, unknown>;
      tool?: McpUiToolMeta;
    }) {
      assertAppToolCall(options);
      await host.authorizeTool(
        options.targetServerId,
        options.name,
        options.arguments,
      );
      return host.callTool(
        options.targetServerId,
        options.name,
        options.arguments,
      );
    },
  };
}
