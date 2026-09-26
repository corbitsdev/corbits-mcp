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
   * Passed through to `@corbits/credential-http`. Empty by default.
   */
  readonly extraOrigins?: Readonly<Record<string, readonly string[]>>;
  /** Reported when a discovery attempt fails; the caller only sees a message. */
  readonly onError?: (error: unknown, context: { url: string }) => void;
};

export type McpCredential = {
  readonly secret: string;
  /** The provider's API origin the secret is pinned to, when it has one. */
  readonly origin?: string;
};

/**
 * Read a tenant credential's decrypted secret and the origin it is pinned to.
 * Scoped by tenant so a credential id from another tenant reads as absent,
 * not as a secret.
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
  if (row === undefined) return undefined;
  const secret = await opts.cipher.decrypt(
    row.secret,
    credentialAad(row.id, "secret"),
  );
  return row.apiBaseUrl === null
    ? { secret }
    : { secret, origin: new URL(row.apiBaseUrl).origin };
}

/** A 3xx would send the bearer onward, so the pinned fetch's manual redirect
 * is turned into a refusal rather than a response the client tries to read. */
function refusingRedirects(inner: FetchLike): FetchLike {
  return async (input, init) => {
    const response = await inner(input, init);
    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `the MCP server answered a ${String(response.status)} redirect; refusing to follow it`,
      );
    }
    return response;
  };
}

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
}): Promise<McpDiscovery> {
  const target = parseMcpEndpoint(args.url);
  const secret = args.credential?.secret;
  const token =
    secret === undefined || secret === MCP_NO_TOKEN_SENTINEL
      ? undefined
      : secret;
  if (token !== undefined && args.credential?.origin === undefined) {
    throw new Error("the credential's provider has no API origin to pin to");
  }
  const origin = args.credential?.origin ?? target.origin;
  const extraOrigins = Object.entries(args.extraOrigins ?? {}).flatMap(
    ([pinned, extra]) => (new URL(pinned).origin === origin ? extra : []),
  );
  const pinned = refusingRedirects(
    createOriginPinnedFetch({
      origin,
      header: "authorization",
      readValue: () => (token === undefined ? undefined : `Bearer ${token}`),
      extraOrigins,
      fetch: args.fetch ?? globalThis.fetch,
    }),
  );
  const serverInfo = await mcpInitialize(args.url, { fetch: pinned });
  const tools = await mcpListTools(args.url, { fetch: pinned });
  return { serverInfo, tools };
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
      opts.onError?.(cause, { url: body.url });
      // The message describes the handshake, never the material it used.
      return c.json(
        {
          error: `the MCP server at ${target.origin} could not be discovered: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
        422,
      );
    }
  });
}
