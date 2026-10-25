import { type } from "arktype";

/** Host-authenticated identity. Never derive these fields from MCP params. */
export type McpIdentity = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly scopes: readonly string[];
  /** Host-assigned cache partition, never a bearer token. */
  readonly authorizationContextId: string;
};

export type McpAuthOperation = {
  readonly resource: string;
  readonly action: string;
};

export type McpAuthPolicy = {
  authenticate(
    request: Request,
  ): McpIdentity | null | Promise<McpIdentity | null>;
  authorize(
    identity: McpIdentity,
    operation: McpAuthOperation,
  ): boolean | Promise<boolean>;
};

const Identity = type({
  tenantId: "string > 0",
  principalId: "string > 0",
  scopes: "string[]",
  authorizationContextId: "string > 0",
});

/** Copies only validated identity fields; extra verifier claims cannot leak. */
export function validateMcpIdentity(value: unknown): McpIdentity {
  const identity = Identity(value);
  if (identity instanceof type.errors)
    throw new Error("Invalid authenticated MCP identity");
  return Object.freeze({
    tenantId: identity.tenantId,
    principalId: identity.principalId,
    scopes: Object.freeze([...identity.scopes]),
    authorizationContextId: identity.authorizationContextId,
  });
}
