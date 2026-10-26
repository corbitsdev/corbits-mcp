import { expect, test } from "bun:test";
import { discoverMcpLoginEntry } from "../oauth-discovery.js";
import { createMcpAuthorizationSession } from "./login.js";

const redirectUri = "http://127.0.0.1:8080/callback";

test("cancel during token exchange does not persist", async () => {
  const issuer = "https://auth.example";
  let persisted = 0;
  let session: ReturnType<typeof createMcpAuthorizationSession>;
  session = createMcpAuthorizationSession({
    entry: {
      resourceUrl: "https://mcp.example/mcp",
      authorizationServer: {
        issuer,
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
        authorizationResponseIssParameterSupported: true,
      },
    },
    client: { kind: "pre-registered", clientId: "client", issuer },
    config: { redirectUri },
    tenantId: "tenant",
    principalId: "principal",
    persist: async () => {
      persisted++;
    },
    fetchImpl: async () => {
      session.cancel();
      return Response.json({ access_token: "access", token_type: "Bearer" });
    },
  });
  const state = new URL(session.authorizeUrl).searchParams.get("state")!;
  const params = new URLSearchParams({ state, iss: issuer, code: "code" });
  await expect(session.complete(params)).rejects.toThrow(/consumed/);
  expect(persisted).toBe(0);
  await expect(session.complete(params)).rejects.toThrow(/consumed/);
  expect(persisted).toBe(0);
});

test("persist failure leaves the exchanged grant retryable", async () => {
  const issuer = "https://auth.example";
  let exchanges = 0;
  let attempts = 0;
  const session = createMcpAuthorizationSession({
    entry: {
      resourceUrl: "https://mcp.example/mcp",
      authorizationServer: {
        issuer,
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
        authorizationResponseIssParameterSupported: true,
      },
    },
    client: { kind: "pre-registered", clientId: "client", issuer },
    config: { redirectUri },
    tenantId: "tenant",
    principalId: "principal",
    persist: async (_binding, tokens) => {
      attempts++;
      if (attempts === 1) throw new Error("disk full");
      expect(tokens.access).toBe("access");
    },
    fetchImpl: async () => {
      exchanges++;
      return Response.json({ access_token: "access", token_type: "Bearer" });
    },
  });
  const state = new URL(session.authorizeUrl).searchParams.get("state")!;
  const params = new URLSearchParams({ state, iss: issuer, code: "code" });
  await expect(session.complete(params)).rejects.toThrow(/disk full/);
  await session.complete(params);
  expect(exchanges).toBe(1);
  expect(attempts).toBe(2);
});

test("same-origin issuer still exchanges when iss is absent", async () => {
  const issuer = "https://auth.example";
  let persisted = 0;
  const session = createMcpAuthorizationSession({
    entry: {
      resourceUrl: "https://mcp.example/mcp",
      authorizationServer: {
        issuer,
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
      },
    },
    client: { kind: "pre-registered", clientId: "client", issuer },
    config: { redirectUri },
    tenantId: "tenant",
    principalId: "principal",
    persist: async () => {
      persisted++;
    },
    fetchImpl: async () =>
      Response.json({ access_token: "access", token_type: "Bearer" }),
  });
  const state = new URL(session.authorizeUrl).searchParams.get("state")!;
  await session.complete(new URLSearchParams({ state, code: "code" }));
  expect(persisted).toBe(1);
});

test("cross-origin token endpoint does not receive the code without a matching iss", async () => {
  const resource = "https://mcp.evil.example/mcp";
  const attacker = "https://attacker.example";
  const honest = "https://idp.honest.example";
  const entry = await discoverMcpLoginEntry({
    resourceUrl: resource,
    fetchImpl: async (input) => {
      const url = String(input);
      if (
        url ===
        "https://mcp.evil.example/.well-known/oauth-protected-resource/mcp"
      )
        return Response.json({
          resource,
          authorization_servers: [attacker],
          scopes_supported: ["read"],
        });
      if (url === `${attacker}/.well-known/oauth-authorization-server`)
        return Response.json({
          issuer: attacker,
          authorization_endpoint: `${honest}/authorize`,
          token_endpoint: `${attacker}/token`,
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["read", "offline_access"],
        });
      return new Response(null, { status: 404 });
    },
  });
  const posts: { url: string; body: string }[] = [];
  let persisted = 0;
  const session = createMcpAuthorizationSession({
    entry,
    client: {
      kind: "cimd",
      clientId: "https://client.example/client.json",
    },
    config: { redirectUri },
    tenantId: "tenant",
    principalId: "principal",
    persist: async () => {
      persisted++;
    },
    fetchImpl: async (input, init) => {
      posts.push({ url: String(input), body: String(init?.body ?? "") });
      return Response.json({ access_token: "access", token_type: "Bearer" });
    },
  });
  const authorize = new URL(session.authorizeUrl);
  expect(authorize.origin).toBe(honest);
  expect(authorize.searchParams.get("scope")).toBe("read");
  const state = authorize.searchParams.get("state")!;
  await expect(
    session.complete(new URLSearchParams({ state, code: "auth-code" })),
  ).rejects.toThrow(/iss/);
  await expect(
    session.complete(
      new URLSearchParams({ state, code: "auth-code", iss: honest }),
    ),
  ).rejects.toThrow(/iss/);
  expect(posts).toHaveLength(0);
  expect(persisted).toBe(0);
  await session.complete(
    new URLSearchParams({ state, code: "auth-code", iss: attacker }),
  );
  expect(persisted).toBe(1);
  expect(posts).toHaveLength(1);
  const body = new URLSearchParams(posts[0]!.body);
  expect(posts[0]!.url).toBe(`${attacker}/token`);
  expect(body.get("code")).toBe("auth-code");
  expect(body.get("code_verifier")?.length).toBeGreaterThan(0);
});
