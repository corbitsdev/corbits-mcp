import assert from "node:assert/strict";
import * as root from "@corbits/mcp";

let persisted = false;
const issuer = "https://auth.example";
const session = root.createMcpAuthorizationSession({
  entry: {
    resourceUrl: "https://mcp.example/mcp",
    authorizationServer: {
      issuer,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
    },
  },
  client: { kind: "pre-registered", clientId: "packed-client", issuer },
  config: { redirectUri: "http://127.0.0.1:8080/callback" },
  tenantId: "tenant",
  principalId: "principal",
  persist: async () => {
    persisted = true;
  },
  fetchImpl: async () => {
    throw new Error("Cancelled session must not exchange tokens");
  },
});
const authorize = new URL(session.authorizeUrl);
assert.equal(authorize.searchParams.get("resource"), "https://mcp.example/mcp");
assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
assert.ok(authorize.searchParams.get("state"));
session.cancel();
await assert.rejects(
  session.complete(
    new URLSearchParams({
      state: authorize.searchParams.get("state"),
      code: "unused",
      iss: issuer,
    }),
  ),
  /consumed|expired/,
);
assert.equal(persisted, false);
console.log("packed auth APIs passed");
