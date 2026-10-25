import { type } from "arktype";
import { assertAuthServerUrl } from "./url-policy.js";
import {
  validateMcpIdentity,
  type McpAuthOperation,
  type McpAuthPolicy,
  type McpIdentity,
} from "./contracts.js";

const VerifiedToken = type({
  issuer: "string > 0",
  audience: "string[]",
  expiresAt: "number",
  "notBefore?": "number",
  identity: "unknown",
});

export type McpResourceServerOptions = {
  resource: string;
  resourceMetadataUrl: string;
  authorizationServers: readonly string[];
  scopesSupported?: readonly string[];
  /** Must verify signature/algorithm/key trust or introspection, revocation and
   * token type. Decoding a JWT is NOT verification. Returns trusted claims,
   * expiresAt/notBefore in epoch milliseconds, and a host-assigned identity.
   * Never map identity from unverified request params. */
  verifyAccessToken(
    token: string,
    context: {
      resource: string;
      issuers: readonly string[];
      signal: AbortSignal;
    },
  ): Promise<unknown>;
  authorize(
    identity: McpIdentity,
    operation: McpAuthOperation,
  ): boolean | Promise<boolean>;
  requiredScopes?(operation: McpAuthOperation): readonly string[];
  now?: () => number;
};

function quote(value: string): string {
  if (/[^\x20-\x7e]/.test(value))
    throw new Error("Invalid authentication challenge value");
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

/** No token implementation or public-mode bypass is implied by this seam. */
export function createMcpResourceServerAuth(opts: McpResourceServerOptions): {
  policy: McpAuthPolicy;
  metadataResponse(): Response;
  challenge(status: 401 | 403, scopes?: readonly string[]): Response;
} {
  assertAuthServerUrl(opts.resource);
  assertAuthServerUrl(opts.resourceMetadataUrl);
  if (opts.authorizationServers.length === 0)
    throw new Error("At least one authorization server is required");
  const issuers = Object.freeze([...opts.authorizationServers]);
  for (const issuer of issuers) assertAuthServerUrl(issuer, true);
  const policy: McpAuthPolicy = {
    async authenticate(request) {
      // RFC 6750 bearer use is header-only: query tokens never authenticate.
      if (new URL(request.url).searchParams.has("access_token")) return null;
      const match = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(
        request.headers.get("authorization") ?? "",
      );
      if (!match?.[1]) return null;
      try {
        const claims = VerifiedToken(
          await opts.verifyAccessToken(match[1], {
            resource: opts.resource,
            issuers,
            signal: request.signal,
          }),
        );
        if (claims instanceof type.errors) return null;
        const now = (opts.now ?? Date.now)();
        if (
          !issuers.includes(claims.issuer) ||
          !claims.audience.includes(opts.resource) ||
          !Number.isFinite(claims.expiresAt) ||
          claims.expiresAt <= now ||
          (claims.notBefore !== undefined &&
            (!Number.isFinite(claims.notBefore) || claims.notBefore > now))
        )
          return null;
        return validateMcpIdentity(claims.identity);
      } catch {
        return null;
      }
    },
    async authorize(identity, operation) {
      try {
        const validated = validateMcpIdentity(identity);
        if (!operation.resource || !operation.action) return false;
        const scopes = opts.requiredScopes?.(operation) ?? [];
        if (!scopes.every((scope) => validated.scopes.includes(scope)))
          return false;
        return (await opts.authorize(validated, operation)) === true;
      } catch {
        return false;
      }
    },
  };
  return {
    policy,
    metadataResponse: () =>
      Response.json({
        resource: opts.resource,
        authorization_servers: issuers,
        ...(opts.scopesSupported !== undefined
          ? { scopes_supported: [...opts.scopesSupported] }
          : {}),
      }),
    challenge(status, scopes) {
      const fields = [`resource_metadata=${quote(opts.resourceMetadataUrl)}`];
      if (status === 403) fields.push('error="insufficient_scope"');
      if (scopes !== undefined) fields.push(`scope=${quote(scopes.join(" "))}`);
      return new Response(null, {
        status,
        headers: {
          "www-authenticate": `Bearer ${fields.join(", ")}`,
          "cache-control": "no-store",
        },
      });
    },
  };
}
