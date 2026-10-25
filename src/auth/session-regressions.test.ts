import { expect, test } from "bun:test";
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
