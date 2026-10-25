import type { createAppHostBridge } from "../../extensions/apps.js";
import type { supportedHostExtensions } from "../../extensions/maturity.js";
import type { McpElicitationHost } from "../../extensions/elicitation.js";
import type {
  McpInputRequired,
  McpTaskHandle,
  McpTool,
  McpToolResult,
  mcpGetTask,
  mcpUpdateTask,
  mcpCancelTask,
} from "../../client.js";

/** Host-bound identity, never credentials or model-supplied routing. */
export interface McpHostContext {
  readonly server: string;
  readonly url: string;
  readonly tool: string;
  readonly callId: string;
  readonly signal: AbortSignal;
}

export interface McpTaskControls {
  get: () => ReturnType<typeof mcpGetTask>;
  /** The host must collect and authorize responses to outstanding inputs. */
  update: (
    responses: Parameters<typeof mcpUpdateTask>[2],
  ) => ReturnType<typeof mcpUpdateTask>;
  /** Cooperative intent, not proof that remote work stopped. */
  cancel: () => ReturnType<typeof mcpCancelTask>;
}

/** Optional services are absent capabilities, never implicit approval. */
export interface McpHostServices {
  /** Explicit host-provided Apps runtime, required only for UI opt-in. The host
   * must use this bridge for UI mounting/tool calls and fulfill the support
   * obligations; structural validation cannot certify a deployed renderer. */
  apps?: {
    readonly bridge: ReturnType<typeof createAppHostBridge>;
    readonly support: NonNullable<
      Parameters<typeof supportedHostExtensions>[0]["apps"]
    >;
  };
  /** Concrete form/URL services; only these advertise elicitation support. */
  elicitation?: McpElicitationHost;
  /** Present elicitation to a user and authorize each answer. Undefined declines.
   * This does not substitute for the Interchange tool invocation approval gate. */
  requestInput?: (
    context: McpHostContext,
    pending: McpInputRequired,
  ) => Promise<Record<string, unknown> | undefined>;
  /** Persist correlation and arrange eventual Agent.deliver before returning.
   * Controls are ephemeral; durable recovery must reacquire a mediated client. */
  adoptTask?: (
    context: McpHostContext,
    task: McpTaskHandle,
    controls: McpTaskControls,
  ) => Promise<{ correlationId: string }>;
  /** Host-only rich content/UI channel; metadata is never model text.
   * This callback alone does not imply Apps rendering support. When opting into
   * UI, wire presentation to the explicitly supplied apps bridge. */
  presentResult?: (
    context: McpHostContext,
    result: McpToolResult,
  ) => Promise<void>;
  /** Check freshness in the host's identity partition before execution. Reject
   * changed schemas/visibility/approval hints and rebuild the synchronous factory;
   * never mutate definitions or grants underneath a running agent. */
  validateCatalog?: (context: McpHostContext, tool: McpTool) => Promise<void>;
}
