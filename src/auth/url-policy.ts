import { parseMcpEndpoint } from "../url.js";

/** Neutral URL-policy error. Keep the existing diagnostic name/message, without
 * loading the optional OAuth implementation solely to construct an exception.
 * OAuth-facing facades translate this to the actual oauth-core error class. */
export class McpAuthUrlError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`OAuth discovery failed: ${detail}`);
    this.name = "OAuthDiscoveryError";
    this.detail = detail;
  }
}

/** OAuth endpoints have no cleartext exception, including internal hosts. */
export function assertAuthServerUrl(raw: string, issuer = false): URL {
  let url: URL;
  try {
    url = parseMcpEndpoint(raw);
  } catch {
    throw new McpAuthUrlError("Invalid OAuth URL");
  }
  if (
    url.protocol !== "https:" ||
    (issuer && (url.search !== "" || raw.includes("?")))
  ) {
    throw new McpAuthUrlError(
      "OAuth URL must use HTTPS; issuer must not contain a query",
    );
  }
  return url;
}

export function assertAuthRedirectUri(raw: string): URL {
  try {
    return parseMcpEndpoint(raw);
  } catch {
    throw new McpAuthUrlError(
      "Invalid OAuth redirect URI: HTTPS or loopback HTTP required",
    );
  }
}
