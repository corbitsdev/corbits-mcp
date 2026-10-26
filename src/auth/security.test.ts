import { expect, test } from "bun:test";
import { exchangeCode, refreshTokenRequest } from "@corbits/oauth-core";
import {
  mcpClientConfig,
  mcpClientIdMetadataDocument,
  resolveStoredMcpClient,
} from "../oauth-discovery.js";
import { parseMcpEndpoint } from "../url.js";

const entry = {
  resourceUrl: "https://mcp.example/mcp",
  authorizationServer: {
    issuer: "https://auth.example",
    authorizationEndpoint: "https://auth.example/authorize",
    tokenEndpoint: "https://auth.example/token",
  },
};

test("issuer-keyed registrations reject trailing slash aliases", () => {
  expect(() =>
    resolveStoredMcpClient("https://auth.example/", {
      kind: "dynamic",
      clientId: "id",
      issuer: "https://auth.example",
    }),
  ).toThrow();
});

test("CIMD rejects encoded dot segments before URL normalization", () => {
  for (const path of [
    "a/%2e%2e/client.json",
    "a/.%2E/client.json",
    "a/%2e/client.json",
  ]) {
    expect(() =>
      mcpClientIdMetadataDocument({
        metadataUrl: `https://client.example/${path}`,
        clientName: "client",
        redirectUris: ["http://127.0.0.1:8080/callback"],
      }),
    ).toThrow();
  }
});

test("credential-bearing and fragment endpoints are refused without quoting secrets", () => {
  for (const url of [
    "https://user:secret@mcp.example/mcp",
    "https://mcp.example/mcp#secret",
  ]) {
    expect(() => parseMcpEndpoint(url)).toThrow();
    try {
      parseMcpEndpoint(url);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  }
});

test("resource propagates through installed oauth-core code and refresh requests", async () => {
  const config = mcpClientConfig(entry, {
    clientId: "client",
    redirectUri: "http://127.0.0.1:8080/callback",
  });
  const bodies: URLSearchParams[] = [];
  const fake = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(new URLSearchParams(String(init?.body)));
      return Response.json({ access_token: "access", token_type: "Bearer" });
    },
    { preconnect: fetch.preconnect },
  );
  await exchangeCode(config, "code", "verifier", fake);
  await refreshTokenRequest(config, "refresh", fake);
  expect(bodies.map((body) => body.get("resource"))).toEqual([
    entry.resourceUrl,
    entry.resourceUrl,
  ]);
});

test("extra authorization parameters cannot replace PKCE, state, identity or scopes", () => {
  for (const key of [
    "state",
    "code_challenge",
    "code_challenge_method",
    "client_id",
    "redirect_uri",
    "response_type",
    "scope",
  ]) {
    expect(() =>
      mcpClientConfig(entry, {
        clientId: "client",
        redirectUri: "http://127.0.0.1:8080/callback",
        extraAuthorizeParams: { [key]: "attacker" },
      }),
    ).toThrow(/security parameters/);
  }
});
