import { expect, test } from "bun:test";
import { discoverMcpLoginEntry } from "../oauth-discovery.js";
import { parseMcpAuthChallenge, mcpStepUpScopes } from "./challenge.js";
import { createMcpResourceServerAuth } from "./resource-server.js";
import {
  createMcpAuthorizationSession,
  prepareMcpClient,
  refreshMcpOAuthTokens,
  type McpOAuthTokens,
} from "./login.js";

const resource = "https://mcp.example/mcp";
const issuer = "https://auth.example/tenant";
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
  code_challenge_methods_supported: ["S256"],
  authorization_response_iss_parameter_supported: true,
};
const identity = {
  tenantId: "tenant",
  principalId: "principal",
  scopes: ["read"],
  authorizationContextId: "partition",
};

function fixture() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    expect(init?.redirect).toBe("error");
    if (url === "https://mcp.example/metadata")
      return Response.json({
        resource,
        authorization_servers: [issuer],
        scopes_supported: ["read"],
      });
    if (url === `${issuer}/.well-known/openid-configuration`)
      return Response.json(metadata);
    if (url === `${issuer}/register`)
      return Response.json({ client_id: "registered" });
    if (url === `${issuer}/token`) {
      expect(new URLSearchParams(String(init?.body)).get("resource")).toBe(
        resource,
      );
      return Response.json({
        access_token: "access",
        token_type: "Bearer",
        scope: "read",
      });
    }
    return new Response(null, { status: 404 });
  };
  return { calls, fetchImpl };
}

test("challenge parser handles other schemes, quoted commas and duplicates", () => {
  expect(
    parseMcpAuthChallenge(
      'Basic realm="a,b", Bearer resource_metadata="https://mcp.example/metadata", scope="read write"',
    ),
  ).toEqual({
    resourceMetadata: "https://mcp.example/metadata",
    scope: "read write",
  });
  expect(() =>
    parseMcpAuthChallenge('Bearer scope="read", scope="write"'),
  ).toThrow();
  expect(() =>
    parseMcpAuthChallenge('Bearer scope="read", Bearer scope="write"'),
  ).toThrow();
  expect(
    mcpStepUpScopes({ error: "insufficient_scope", scope: "write read" }, [
      "read",
    ]),
  ).toEqual(["read", "write"]);
});

test("complete challenge/OIDC/DCR/login/credential/request flow accepts a token-only response", async () => {
  const { calls, fetchImpl } = fixture();
  const auth = createMcpResourceServerAuth({
    resource,
    resourceMetadataUrl: "https://mcp.example/metadata",
    authorizationServers: [issuer],
    verifyAccessToken: async (token) =>
      token === "access"
        ? {
            issuer,
            audience: [resource],
            expiresAt: Date.now() + 60000,
            identity,
          }
        : null,
    authorize: (id, op) =>
      id.tenantId === "tenant" &&
      op.resource === "tool:read" &&
      op.action === "execute",
    requiredScopes: () => ["read"],
  });
  const initial = new Request(resource);
  expect(await auth.policy.authenticate(initial)).toBeNull();
  const entry = await discoverMcpLoginEntry({
    resourceUrl: resource,
    wwwAuthenticate: auth
      .challenge(401, ["read"])
      .headers.get("www-authenticate")!,
    fetchImpl,
  });
  expect(calls.map((call) => call.url)).toEqual([
    "https://mcp.example/metadata",
    "https://auth.example/.well-known/oauth-authorization-server/tenant",
    "https://auth.example/.well-known/openid-configuration/tenant",
    `${issuer}/.well-known/openid-configuration`,
  ]);
  const client = await prepareMcpClient({
    entry,
    clientName: "client",
    redirectUri: "http://127.0.0.1:8080/callback",
    fetchImpl,
  });
  let stored: McpOAuthTokens | undefined;
  const session = createMcpAuthorizationSession({
    entry,
    client,
    config: { redirectUri: "http://127.0.0.1:8080/callback" },
    tenantId: "tenant",
    principalId: "principal",
    fetchImpl,
    persist: async (binding, tokens) => {
      expect(binding.resource).toBe(resource);
      expect(binding.tenantId).toBe("tenant");
      stored = tokens;
    },
  });
  const authorize = new URL(session.authorizeUrl);
  expect(authorize.searchParams.get("resource")).toBe(resource);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  const params = new URLSearchParams({
    state: authorize.searchParams.get("state")!,
    code: "code",
    iss: issuer,
  });
  await session.complete(params);
  expect(stored).toEqual({ access: "access", scope: "read" });
  await expect(session.complete(params)).rejects.toThrow(/consumed/);
  const authenticated = await auth.policy.authenticate(
    new Request(resource, {
      headers: { authorization: `Bearer ${stored?.access}` },
    }),
  );
  expect(authenticated).toEqual(identity);
  expect(
    await auth.policy.authorize(authenticated!, {
      resource: "tool:read",
      action: "execute",
    }),
  ).toBe(true);
  expect(
    await auth.policy.authorize(authenticated!, {
      resource: "tool:delete",
      action: "execute",
    }),
  ).toBe(false);
  await expect(
    refreshMcpOAuthTokens({
      entry,
      client,
      binding: session.binding,
      tokens: stored!,
    }),
  ).rejects.toThrow(/new authorization/);
});

test("PRM path then root precedes AS lookup; exact issuer mismatches stop discovery", async () => {
  const seen: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("oauth-protected-resource/mcp"))
      return new Response(null, { status: 404 });
    if (url.endsWith("oauth-protected-resource"))
      return Response.json({ resource, authorization_servers: [issuer] });
    return Response.json({ ...metadata, issuer: `${issuer}/` });
  };
  await expect(
    discoverMcpLoginEntry({ resourceUrl: resource, fetchImpl }),
  ).rejects.toThrow(/issuer mismatch/);
  expect(seen).toHaveLength(3);
  expect(seen[1]).toBe(
    "https://mcp.example/.well-known/oauth-protected-resource",
  );
});

test("inbound wrong issuer, audience, expiry, identity and query tokens fail closed", async () => {
  for (const overrides of [
    { issuer: `${issuer}/` },
    { audience: ["https://other.example"] },
    { expiresAt: 0 },
    { identity: { ...identity, tenantId: "" } },
    { notBefore: Date.now() + 60000 },
  ]) {
    const auth = createMcpResourceServerAuth({
      resource,
      resourceMetadataUrl: "https://mcp.example/metadata",
      authorizationServers: [issuer],
      verifyAccessToken: async () => ({
        issuer,
        audience: [resource],
        expiresAt: Date.now() + 60000,
        identity,
        ...overrides,
      }),
      authorize: () => true,
    });
    expect(
      await auth.policy.authenticate(
        new Request(resource, { headers: { authorization: "Bearer access" } }),
      ),
    ).toBeNull();
    expect(
      await auth.policy.authenticate(
        new Request(`${resource}?access_token=access`),
      ),
    ).toBeNull();
  }
});

test("wrong state/issuer and duplicate callback fields never redeem a code", async () => {
  const entry = {
    resourceUrl: resource,
    authorizationServer: {
      issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      authorizationResponseIssParameterSupported: true,
    },
  };
  let exchanges = 0;
  const session = createMcpAuthorizationSession({
    entry,
    client: { kind: "pre-registered", issuer, clientId: "pre" },
    config: { redirectUri: "http://127.0.0.1:8080/callback" },
    tenantId: "tenant",
    principalId: "principal",
    persist: async () => {},
    fetchImpl: async () => {
      exchanges++;
      return Response.json({ access_token: "access", token_type: "Bearer" });
    },
  });
  const state = new URL(session.authorizeUrl).searchParams.get("state")!;
  for (const params of [
    new URLSearchParams({ state: "wrong", iss: issuer, code: "code" }),
    new URLSearchParams({ state, iss: `${issuer}/`, code: "code" }),
    new URLSearchParams(
      `state=${state}&iss=${encodeURIComponent(issuer)}&code=a&code=b`,
    ),
  ])
    await expect(session.complete(params)).rejects.toThrow();
  expect(exchanges).toBe(0);
});

test("CIMD and pre-registered clients avoid DCR; refresh retains resource and rotated token", async () => {
  const entry = {
    resourceUrl: resource,
    authorizationServer: {
      issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      clientIdMetadataDocumentSupported: true,
    },
  };
  const cimd = await prepareMcpClient({
    entry,
    clientName: "client",
    redirectUri: "https://client.example/callback",
    clientMetadataUrl: "https://client.example/client.json",
  });
  expect(cimd).toEqual({
    kind: "cimd",
    clientId: "https://client.example/client.json",
  });
  const pre = await prepareMcpClient({
    entry,
    clientName: "client",
    redirectUri: "https://client.example/callback",
    storedClient: { kind: "pre-registered", clientId: "pre", issuer },
    clientMetadataUrl: "https://client.example/client.json",
  });
  expect(pre.kind).toBe("pre-registered");
  const binding = {
    tenantId: "tenant",
    principalId: "principal",
    issuer,
    resource,
    clientId: "pre",
  };
  const refreshed = await refreshMcpOAuthTokens({
    entry,
    client: pre,
    binding,
    tokens: { access: "old", refresh: "refresh" },
    fetchImpl: async (_input, init) => {
      expect(init?.redirect).toBe("error");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("resource")).toBe(resource);
      expect(body.get("refresh_token")).toBe("refresh");
      return Response.json({
        access_token: "new",
        refresh_token: "rotated",
        token_type: "Bearer",
      });
    },
  });
  expect(refreshed).toEqual({ access: "new", refresh: "rotated" });
  await expect(
    refreshMcpOAuthTokens({
      entry,
      client: pre,
      binding: { ...binding, resource: "https://other.example/mcp" },
      tokens: refreshed,
    }),
  ).rejects.toThrow(/binding/);
});
