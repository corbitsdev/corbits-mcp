import { OAuthDiscoveryError } from "@corbits/oauth-core";

export type McpAuthChallenge = {
  resourceMetadata?: string;
  scope?: string;
  error?: string;
};

/** RFC 9110 challenge lists: commas inside quoted strings are not separators. */
export function parseMcpAuthChallenge(
  header: string | null | undefined,
): McpAuthChallenge | undefined {
  if (!header) return undefined;
  if (header.length > 16384 || /[\r\n]/.test(header))
    throw new OAuthDiscoveryError("Invalid authentication challenge");
  const parts = header.match(/(?:[^,"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
  let bearer = false;
  let found = false;
  const params = new Map<string, string>();
  for (const part of parts) {
    let text = part.trim();
    const scheme = /^([!#$%&'*+.^_`|~\w-]+)(?:\s+|$)(.*)$/.exec(text);
    if (scheme && !/^\s*=/.test(scheme[2] ?? "")) {
      bearer = scheme[1]?.toLowerCase() === "bearer";
      if (bearer && found)
        throw new OAuthDiscoveryError("Ambiguous Bearer challenge");
      if (bearer) found = true;
      text = scheme[2] ?? "";
    }
    if (!bearer || !text) continue;
    const pair =
      /^([!#$%&'*+.^_`|~\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+.^_`|~\w-]+))$/.exec(
        text,
      );
    if (!pair) throw new OAuthDiscoveryError("Malformed Bearer challenge");
    const key = pair[1]!.toLowerCase();
    if (params.has(key))
      throw new OAuthDiscoveryError("Duplicate Bearer challenge parameter");
    params.set(key, (pair[2] ?? pair[3] ?? "").replace(/\\(.)/g, "$1"));
  }
  if (!found) return undefined;
  return {
    ...(params.has("resource_metadata")
      ? { resourceMetadata: params.get("resource_metadata")! }
      : {}),
    ...(params.has("scope") ? { scope: params.get("scope")! } : {}),
    ...(params.has("error") ? { error: params.get("error")! } : {}),
  };
}

/** Step-up is an explicit host decision, never an automatic replay or grant widening. */
export function mcpStepUpScopes(
  challenge: McpAuthChallenge,
  granted: readonly string[],
): string[] {
  if (
    challenge.error !== "insufficient_scope" ||
    challenge.scope === undefined
  ) {
    throw new OAuthDiscoveryError("No actionable insufficient_scope challenge");
  }
  return [
    ...new Set([...granted, ...challenge.scope.split(" ").filter(Boolean)]),
  ];
}
