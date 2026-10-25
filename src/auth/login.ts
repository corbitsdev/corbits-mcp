import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  generateState,
  refreshTokenRequest,
  OAuthDiscoveryError,
} from "@corbits/oauth-core";
import { type } from "arktype";
import {
  assertAuthorizationCallbackIssuer,
  mcpClientConfig,
  preferredMcpClientRegistration,
  readAuthorizationCallback,
  registerMcpClient,
  resolveStoredMcpClient,
  type McpClientConfigOptions,
  type McpLoginEntry,
  type StoredMcpClient,
} from "../oauth-discovery.js";
import { secureOAuthFetch, type FetchLike } from "./http.js";

/** Host-only secret material. Never expose through MCP results or agent context. */
export type McpOAuthTokens = {
  access: string;
  refresh?: string;
  expiresAt?: number;
  scope?: string;
};
export type McpOAuthBinding = {
  tenantId: string;
  principalId: string;
  issuer: string;
  resource: string;
  clientId: string;
};
const Token = type({
  access_token: "string > 0",
  token_type: "string",
  "refresh_token?": "string > 0",
  "expires_in?": "number >= 0",
  "scope?": "string",
});

function tokensFromResponse(
  raw: unknown,
  now: number,
  previous?: McpOAuthTokens,
): McpOAuthTokens {
  const response = Token(raw);
  if (
    response instanceof type.errors ||
    response.token_type.toLowerCase() !== "bearer"
  )
    throw new OAuthDiscoveryError("Invalid bearer token response");
  const refresh = response.refresh_token ?? previous?.refresh;
  return {
    access: response.access_token,
    ...(refresh !== undefined ? { refresh } : {}),
    ...(response.expires_in !== undefined
      ? { expiresAt: now + response.expires_in * 1000 }
      : {}),
    ...(response.scope !== undefined
      ? { scope: response.scope }
      : previous?.scope !== undefined
        ? { scope: previous.scope }
        : {}),
  };
}

/** Performs real DCR only when neither issuer-bound pre-registration nor CIMD applies. */
export async function prepareMcpClient(opts: {
  entry: McpLoginEntry;
  storedClient?: StoredMcpClient;
  clientMetadataUrl?: string;
  clientName: string;
  redirectUri: string;
  /** Hosted web callbacks use "web"; native/loopback clients default to "native". */
  applicationType?: "native" | "web";
  fetchImpl?: FetchLike;
}): Promise<StoredMcpClient> {
  const issuer = opts.entry.authorizationServer.issuer;
  if (opts.storedClient !== undefined) {
    resolveStoredMcpClient(issuer, opts.storedClient);
    return { ...opts.storedClient };
  }
  const plan = preferredMcpClientRegistration({
    authorizationServer: opts.entry.authorizationServer,
    ...(opts.clientMetadataUrl !== undefined
      ? { clientMetadataUrl: opts.clientMetadataUrl }
      : {}),
  });
  if (plan.mechanism === "client-id-metadata")
    return { kind: "cimd", clientId: plan.clientId };
  if (plan.mechanism === "pre-registered")
    return { kind: "pre-registered", clientId: plan.clientId, issuer };
  const registered = await registerMcpClient({
    registrationEndpoint: plan.registrationEndpoint,
    issuer,
    redirectUris: [opts.redirectUri],
    clientName: opts.clientName,
    ...(opts.applicationType !== undefined
      ? { applicationType: opts.applicationType }
      : {}),
    ...(opts.entry.authorizationServer.grantTypesSupported !== undefined
      ? {
          grantTypesSupported:
            opts.entry.authorizationServer.grantTypesSupported,
        }
      : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return { kind: "dynamic", clientId: registered.clientId, issuer };
}

/** A one-use callback session. The host mounts its registered callback route,
 * passes the full URLSearchParams here, then persists secrets server-side.
 * Unlike oauth-core BaseTokens this contract permits access-token-only grants.
 * No automatic tool replay, persistence, browser opening or grant widening. */
export function createMcpAuthorizationSession(opts: {
  entry: McpLoginEntry;
  client: StoredMcpClient;
  config: Omit<McpClientConfigOptions, "clientId">;
  tenantId: string;
  principalId: string;
  persist(binding: McpOAuthBinding, tokens: McpOAuthTokens): Promise<void>;
  fetchImpl?: FetchLike;
  now?: () => number;
  expiresInMs?: number;
}) {
  if (!opts.tenantId || !opts.principalId)
    throw new OAuthDiscoveryError(
      "Login requires host-bound tenant and principal",
    );
  const client = resolveStoredMcpClient(
    opts.entry.authorizationServer.issuer,
    opts.client,
  );
  const config = mcpClientConfig(opts.entry, {
    ...opts.config,
    clientId: client.clientId,
  });
  const pkce = generatePkce();
  const state = generateState();
  const now = opts.now ?? Date.now;
  const expiresAt = now() + (opts.expiresInMs ?? 300_000);
  const binding = Object.freeze({
    tenantId: opts.tenantId,
    principalId: opts.principalId,
    issuer: opts.entry.authorizationServer.issuer,
    resource: opts.entry.resourceUrl,
    clientId: client.clientId,
  });
  let consumed = false;
  const authorizeUrl = new URL(buildAuthorizeUrl(config, pkce, state));
  if (config.scopes.length === 0) authorizeUrl.searchParams.delete("scope");
  return {
    authorizeUrl: authorizeUrl.toString(),
    binding,
    cancel() {
      consumed = true;
    },
    async complete(params: URLSearchParams): Promise<void> {
      if (consumed || now() >= expiresAt)
        throw new OAuthDiscoveryError(
          "Authorization session expired or already consumed",
        );
      if (params.getAll("state").length !== 1 || params.get("state") !== state)
        throw new OAuthDiscoveryError("Authorization state mismatch");
      const issuerOptions = {
        recordedIssuer: binding.issuer,
        ...(opts.entry.authorizationServer
          .authorizationResponseIssParameterSupported !== undefined
          ? {
              authorizationResponseIssParameterSupported:
                opts.entry.authorizationServer
                  .authorizationResponseIssParameterSupported,
            }
          : {}),
      };
      assertAuthorizationCallbackIssuer(params, issuerOptions);
      // An authentic terminal denial must consume the same one-use session as a code.
      consumed = true;
      const { code } = readAuthorizationCallback(params, issuerOptions);
      let tokens: McpOAuthTokens;
      try {
        tokens = tokensFromResponse(
          await exchangeCode(
            config,
            code,
            pkce.verifier,
            secureOAuthFetch(opts.fetchImpl),
          ),
          now(),
        );
      } catch {
        throw new OAuthDiscoveryError("OAuth code exchange failed");
      }
      await opts.persist(binding, tokens);
    },
  };
}

/** Refresh under the same recorded issuer/resource/client binding. */
export async function refreshMcpOAuthTokens(opts: {
  entry: McpLoginEntry;
  client: StoredMcpClient;
  binding: McpOAuthBinding;
  tokens: McpOAuthTokens;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<McpOAuthTokens> {
  const { clientId } = resolveStoredMcpClient(
    opts.entry.authorizationServer.issuer,
    opts.client,
  );
  if (
    opts.binding.issuer !== opts.entry.authorizationServer.issuer ||
    opts.binding.resource !== opts.entry.resourceUrl ||
    opts.binding.clientId !== clientId
  )
    throw new OAuthDiscoveryError("OAuth refresh binding mismatch");
  if (opts.tokens.refresh === undefined)
    throw new OAuthDiscoveryError(
      "Access-token-only grant requires a new authorization",
    );
  try {
    const response = await refreshTokenRequest(
      {
        clientId,
        tokenUrl: opts.entry.authorizationServer.tokenEndpoint,
        resource: opts.binding.resource,
        tokenTimeoutMs: 30_000,
      },
      opts.tokens.refresh,
      secureOAuthFetch(opts.fetchImpl),
    );
    return tokensFromResponse(response, (opts.now ?? Date.now)(), opts.tokens);
  } catch {
    throw new OAuthDiscoveryError("OAuth refresh failed");
  }
}
