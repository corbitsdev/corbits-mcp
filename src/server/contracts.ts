import type { McpAuthPolicy, McpIdentity } from "../auth/contracts.js";
import type {
  McpExtensionSettings,
  McpValidationContext,
  McpMethodMap,
  McpSubscriptionFilter,
} from "../protocol/types.js";

/** Provider values are validated by the shared protocol boundary before transmission. */
export type McpOperationOutcome = McpMethodMap["tools/call"]["result"];

export type McpRequestContext = {
  identity: McpIdentity | null;
  requestId: string | number;
  protocolVersion: string;
  clientCapabilities: Record<string, unknown>;
  signal: AbortSignal;
  notify: (method: string, params: Record<string, unknown>) => void;
  reportProgress: (progress: number, total?: number, message?: string) => void;
};

export type McpProvider = {
  /** Authorization applies to both catalog and execution methods. */
  resource: string;
  action: string;
  schemas?: (
    params: Record<string, unknown>,
  ) => Pick<McpValidationContext, "inputSchema" | "outputSchema">;
  /** subscriptions/listen only: accept a supported subset before acknowledgement.
   * Without this hook no notifications are accepted. Must not emit notifications. */
  acceptSubscription?: (
    params: Record<string, unknown>,
    context: McpRequestContext,
  ) => McpSubscriptionFilter | Promise<McpSubscriptionFilter>;
  handle: (
    params: Record<string, unknown>,
    context: McpRequestContext,
  ) => McpOperationOutcome | Promise<McpOperationOutcome>;
};

/** Only known protocol methods may be registered. Discovery is server-owned. */
export type McpProviders = Readonly<Record<string, McpProvider>>;

export type McpLegacyRevision = "2025-11-25" | "2025-06-18" | "2025-03-26";
export type McpLegacyOptions = {
  /** Explicitly supported revisions; defaults to all three 2025 Streamable HTTP revisions. */
  versions?: readonly McpLegacyRevision[];
  /** Absolute session lifetime, not renewed by traffic. Default: 30 minutes. */
  sessionTtlMs?: number;
  /** Per-server bound. Defaults to 1024; host must provide affinity across replicas. */
  maxSessions?: number;
};

export type McpServerOptions = {
  serverInfo: { name: string; version: string; title?: string };
  providers?: McpProviders;
  /** Required for private servers; public access must be explicitly selected. */
  auth: McpAuthPolicy | "public";
  /** Requests with Origin are refused unless explicitly allowed here. */
  allowedOrigins?: readonly string[];
  /** Pass the resource-server auth factory challenge to preserve OAuth discovery headers. */
  challenge?: (status: 401 | 403, scopes?: readonly string[]) => Response;
  extensions?: McpExtensionSettings;
  maxRequestBytes?: number;
  /** Opt-in, identity-bound legacy sessions. Modern requests remain stateless. */
  legacy?: McpLegacyOptions;
};

export type McpServer = {
  fetch: (request: Request) => Promise<Response>;
  close: () => Promise<void>;
};
