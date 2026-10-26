export const McpErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  HeaderMismatch: -32020,
  MissingRequiredClientCapability: -32021,
  UnsupportedProtocolVersion: -32022,
} as const;

export class McpError extends Error {
  readonly status: number | undefined;
  readonly code: number | undefined;
  readonly data: unknown;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly wwwAuthenticate: string | undefined;
  /** Peer RPC errors are distinct from local validation/transport failures. */
  readonly source: "local" | "peer";
  constructor(
    message: string,
    status?: number,
    code?: number,
    data?: unknown,
    flags?: {
      timedOut?: boolean;
      cancelled?: boolean;
      wwwAuthenticate?: string;
      source?: "local" | "peer";
    },
  ) {
    super(message);
    this.name = "McpError";
    this.status = status;
    this.code = code;
    this.data = data;
    this.timedOut = flags?.timedOut === true;
    this.cancelled = flags?.cancelled === true;
    this.wwwAuthenticate = flags?.wwwAuthenticate;
    this.source = flags?.source ?? "local";
  }
}
