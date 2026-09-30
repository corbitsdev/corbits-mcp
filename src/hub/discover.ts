// Server-side MCP catalog discovery. The browser never holds an MCP server's
// token, so the only place an OAuth-protected server's `tools/list` can be
// read is here, behind the hub's own tenant-member gate and with the secret
// decrypted in this process and sent only to the credential's own origin.

import type { DB } from "@intx/db";
import { credential, provider } from "@intx/db/schema";
import type { FetchLike } from "@intx/harness";
import type { TenantEnv } from "@intx/hub-api";
import { credentialAad, type CredentialCipher } from "@intx/types";
import {
  createOriginPinnedFetch,
  MCP_NO_TOKEN_SENTINEL,
} from "@corbits/credential-http";
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import type { Hono, MiddlewareHandler } from "hono";

import {
  McpError,
  mcpInitialize,
  mcpListTools,
  type McpTool,
  type McpServerInfo,
} from "../client.js";
import { parseMcpEndpoint } from "../url.js";

const DiscoverBody = type({
  url: "string > 0",
  "credentialId?": "string > 0",
});

export type MountMcpDiscoveryOpts = {
  readonly db: DB["db"];
  readonly cipher: CredentialCipher;
  /** The host's stock grant middleware, so authority is checked exactly once, its way. */
  readonly requireGrant: MiddlewareHandler<TenantEnv>;
  /**
   * Further origins a credential may be sent to, keyed by the credential's
   * pinned origin, for a server whose MCP endpoint is not on that origin.
   * Host-wide: an entry applies to every tenant's credential pinned to that
   * origin. Passed through to `@corbits/credential-http`. Empty by default.
   */
  readonly extraOrigins?: Readonly<Record<string, readonly string[]>>;
  /**
   * Allow plain-http loopback targets, for local development only. Off by
   * default so the route cannot be pointed at the hub's own ports.
   */
  readonly allowLoopback?: boolean;
  /** Reported when a discovery attempt fails; the caller only sees a message. */
  readonly onError?: (error: unknown, context: { url: string }) => void;
};

export type McpCredential = {
  readonly secret: string;
  /** The provider's API origin the secret is pinned to, when it has one. */
  readonly origin?: string;
};

/**
 * Credential types whose secret is a bearer token. An `oauth_token` row's
 * secret is the current access token, which `@corbits/oauth-core`'s refresher
 * rewrites in place, so it is read here like any other and never refreshed.
 */
const BEARER_CREDENTIAL_TYPES: readonly string[] = ["api_key", "oauth_token"];

/**
 * Read a tenant credential's decrypted secret and the origin it is pinned to.
 * Scoped by tenant so a credential id from another tenant reads as absent,
 * not as a secret; a revoked, errored or expired credential, or one that holds no bearer
 * token (a certificate, say), reads as absent too.
 */
export async function readCredential(opts: {
  readonly db: DB["db"];
  readonly cipher: CredentialCipher;
  readonly tenantId: string;
  readonly credentialId: string;
}): Promise<McpCredential | undefined> {
  const [row] = await opts.db
    .select({
      id: credential.id,
      secret: credential.secret,
      type: credential.type,
      status: credential.status,
      expiresAt: credential.expiresAt,
      apiBaseUrl: provider.apiBaseUrl,
    })
    .from(credential)
    .innerJoin(provider, eq(provider.id, credential.providerId))
    .where(
      and(
        eq(credential.id, opts.credentialId),
        eq(credential.tenantId, opts.tenantId),
      ),
    )
    .limit(1);
  if (
    row === undefined ||
    !BEARER_CREDENTIAL_TYPES.includes(row.type) ||
    row.status !== "active" ||
    (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now())
  ) {
    return undefined;
  }
  const secret = await opts.cipher.decrypt(
    row.secret,
    credentialAad(row.id, "secret"),
  );
  return row.apiBaseUrl === null
    ? { secret }
    : { secret, origin: new URL(row.apiBaseUrl).origin };
}

const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

/** A 3xx would send the bearer onward, so the pinned fetch's manual redirect
 * is turned into a refusal rather than a response the client tries to read. */
function refusingRedirects(inner: FetchLike): FetchLike {
  return async (input, init) => {
    const response = await inner(input, init);
    if (response.status >= 300 && response.status < 400) {
      throw new McpError(
        `the MCP server answered a ${String(response.status)} redirect; refusing to follow it`,
      );
    }
    return response;
  };
}

/** How long one discovery request, including its body, may take. */
const DISCOVERY_TIMEOUT_MS = 30_000;

export type McpDiscovery = {
  readonly serverInfo: McpServerInfo;
  readonly tools: readonly McpTool[];
};

/**
 * Handshake and read a server's catalog over a fetch pinned to the
 * credential's origin, or to the URL's origin when no secret is sent.
 */
export async function discoverMcpServer(args: {
  readonly url: string;
  readonly credential?: McpCredential;
  readonly extraOrigins?: Readonly<Record<string, readonly string[]>>;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}): Promise<McpDiscovery> {
  const target = parseMcpEndpoint(args.url);
  const secret = args.credential?.secret;
  const token =
    secret === undefined || secret === MCP_NO_TOKEN_SENTINEL
      ? undefined
      : secret;
  const origin = token === undefined ? target.origin : args.credential?.origin;
  if (origin === undefined) {
    throw new McpError("the credential's provider has no API origin to pin to");
  }
  // A secret that is not a valid header value makes fetch throw a message
  // quoting it, so it is refused here with a fixed one.
  if (token !== undefined && !HEADER_VALUE.test(token)) {
    throw new McpError("the credential's secret is not a valid header value");
  }
  const extraOrigins = Object.entries(args.extraOrigins ?? {}).flatMap(
    ([pinned, extra]) => (new URL(pinned).origin === origin ? extra : []),
  );
  const allowed = [origin, ...extraOrigins.map((o) => new URL(o).origin)];
  if (!allowed.includes(target.origin)) {
    throw new McpError(
      `credential is pinned to ${origin}; refusing cross-origin request to ${target.origin}`,
    );
  }
  const pinned = refusingRedirects(
    createOriginPinnedFetch({
      origin,
      header: "authorization",
      readValue: () => (token === undefined ? undefined : `Bearer ${token}`),
      extraOrigins,
      fetch: args.fetch ?? globalThis.fetch,
    }),
  );
  const client = {
    fetch: pinned,
    timeoutMs: args.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
  };
  const session = await mcpInitialize(args.url, client);
  const tools = await mcpListTools(args.url, { ...client, session });
  return {
    serverInfo: {
      protocolVersion: session.protocolVersion,
      ...(session.serverInfo !== undefined
        ? { serverInfo: session.serverInfo }
        : {}),
    },
    tools,
  };
}

/**
 * Mount `POST /mcp/discover` on a tenant router. It answers with the server's
 * identification and its whole tool catalog, which a deployer stores and
 * hands to the sidecar bundle; the bundle itself never discovers anything.
 */
export function mountMcpDiscovery(
  app: Hono<TenantEnv>,
  opts: MountMcpDiscoveryOpts,
): void {
  app.post("/mcp/discover", opts.requireGrant, async (c) => {
    const body = DiscoverBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json({ error: body.summary }, 400);
    }
    let target: URL;
    try {
      target = parseMcpEndpoint(body.url);
    } catch (cause) {
      return c.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        400,
      );
    }
    if (target.protocol === "http:" && opts.allowLoopback !== true) {
      return c.json({ error: "the MCP server URL must be https" }, 400);
    }

    try {
      const found =
        body.credentialId === undefined
          ? undefined
          : await readCredential({
              db: opts.db,
              cipher: opts.cipher,
              tenantId: c.get("tenant").id,
              credentialId: body.credentialId,
            });
      if (body.credentialId !== undefined && found === undefined) {
        return c.json({ error: "credential not found" }, 404);
      }
      const data = await discoverMcpServer({
        url: body.url,
        ...(found !== undefined ? { credential: found } : {}),
        ...(opts.extraOrigins !== undefined
          ? { extraOrigins: opts.extraOrigins }
          : {}),
      });
      return c.json({ data });
    } catch (cause) {
      // Only this package's own messages are passed on: anything else, such
      // as a fetch error, may quote the material the request carried. An
      // upstream status is not echoed, so the route is no port-probing oracle.
      const error =
        cause instanceof McpError && cause.status === undefined
          ? cause
          : new McpError(
              cause instanceof McpError
                ? "the server refused the request"
                : "the handshake failed",
            );
      opts.onError?.(error, { url: body.url });
      return c.json(
        {
          error: `the MCP server at ${target.origin} could not be discovered: ${error.message}`,
        },
        422,
      );
    }
  });
}
