// One rule for which MCP endpoints a token may be sent to, shared by the
// deploy-time config check and the hub's discovery route.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Parse an MCP endpoint and require https, so a bearer never crosses the
 * network in the clear. Loopback is the one exemption: a server running on
 * the same machine has no network hop to protect.
 */
export function parseMcpEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new Error(
      `"${raw}" is not an absolute URL (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new Error(
    `MCP endpoint "${raw}" must be https (http is allowed only on loopback)`,
  );
}
