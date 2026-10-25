import { OAuthDiscoveryError } from "@corbits/oauth-core";
import type { FetchLike } from "../protocol/types.js";
import {
  assertAuthServerUrl,
  assertAuthRedirectUri,
  McpAuthUrlError,
} from "./url-policy.js";

function withOAuthError(validate: () => URL): URL {
  try {
    return validate();
  } catch (error) {
    if (error instanceof McpAuthUrlError)
      throw new OAuthDiscoveryError(error.detail);
    throw error;
  }
}

/** Compatibility facade retaining oauth-core error identity for OAuth callers. */
export function assertOAuthUrl(raw: string, issuer = false): URL {
  return withOAuthError(() => assertAuthServerUrl(raw, issuer));
}

export function assertRedirectUri(raw: string): URL {
  return withOAuthError(() => assertAuthRedirectUri(raw));
}

/** Use for every oauth-core token call: its default fetch follows redirects. */
export function secureOAuthFetch(
  inner: FetchLike = globalThis.fetch,
): typeof fetch {
  const wrapped = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    assertOAuthUrl(input instanceof Request ? input.url : String(input));
    const response = await inner(input, { ...init, redirect: "error" });
    if (
      (response.status >= 300 && response.status < 400) ||
      response.redirected
    ) {
      throw new OAuthDiscoveryError("OAuth endpoint redirect refused");
    }
    return response;
  };
  return Object.assign(wrapped, { preconnect: globalThis.fetch.preconnect });
}
