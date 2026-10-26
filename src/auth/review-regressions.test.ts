import { expect, test } from "bun:test";
import { type } from "arktype";
import { createMcpAuthorizationSession, prepareMcpClient } from "./login.js";
import { createMcpCallbackAdapter } from "./callback.js";
import {
  mcpClientIdMetadataDocument,
  preferredMcpClientRegistration,
  resolveStoredMcpClient,
} from "../oauth-discovery.js";

const issuer = "https://auth.example";
const entry = {
  resourceUrl: "https://mcp.example/mcp",
  authorizationServer: {
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    registrationEndpoint: `${issuer}/register`,
    authorizationResponseIssParameterSupported: true,
  },
};
const redirectUri = "http://127.0.0.1:8080/callback";

test("authenticated denial consumes a session; wrong state and issuer do not", async () => {
  let exchanges = 0;
  let persisted = 0;
  const session = createMcpAuthorizationSession({
    entry,
    client: { kind: "pre-registered", clientId: "client", issuer },
    config: { redirectUri },
    tenantId: "tenant",
    principalId: "principal",
    persist: async () => {
      persisted++;
    },
    fetchImpl: async () => {
      exchanges++;
      return Response.json({ access_token: "access", token_type: "Bearer" });
    },
  });
  const state = new URL(session.authorizeUrl).searchParams.get("state")!;
  await expect(
    session.complete(
      new URLSearchParams({
        state: "wrong",
        iss: issuer,
        error: "access_denied",
      }),
    ),
  ).rejects.toThrow(/state/);
  await expect(
    session.complete(
      new URLSearchParams({
        state,
        iss: "https://wrong.example",
        error: "access_denied",
      }),
    ),
  ).rejects.toThrow(/issuer/);
  await expect(
    session.complete(
      new URLSearchParams({ state, iss: issuer, error: "access_denied" }),
    ),
  ).rejects.toThrow(/rejected/);
  await expect(
    session.complete(
      new URLSearchParams({ state, iss: issuer, code: "later" }),
    ),
  ).rejects.toThrow(/consumed/);
  expect(exchanges).toBe(0);
  expect(persisted).toBe(0);
});

test("callback adapter preserves pending login on wrong issuer, but denial is terminal", async () => {
  const adapter = createMcpCallbackAdapter({
    expectedState: "state",
    redirectUri,
    issuer: {
      recordedIssuer: issuer,
      authorizationResponseIssParameterSupported: true,
    },
    closeListener() {},
  });
  expect(
    adapter.fetch(
      new Request(
        `${redirectUri}?state=state&iss=https://wrong.example&error=access_denied`,
      ),
    ).status,
  ).toBe(400);
  expect(
    adapter.fetch(
      new Request(
        `${redirectUri}?state=wrong&iss=${issuer}&error=access_denied`,
      ),
    ).status,
  ).toBe(400);
  expect(
    adapter.fetch(
      new Request(
        `${redirectUri}?state=state&iss=${issuer}&error=access_denied`,
      ),
    ).status,
  ).toBe(400);
  expect(
    adapter.fetch(
      new Request(`${redirectUri}?state=state&iss=${issuer}&code=later`),
    ).status,
  ).toBe(409);
  await expect(
    adapter.waitForCode(new AbortController().signal),
  ).rejects.toThrow();
  adapter.close();
});

test("CIMD raw terminal dot segments before query are rejected at every entry point", () => {
  for (const segment of [".", "..", "%2e", "%2E%2e", ".%2E", "%2e."]) {
    const metadataUrl = `https://client.example/a/b/${segment}?v=1`;
    expect(() =>
      mcpClientIdMetadataDocument({
        metadataUrl,
        clientName: "client",
        redirectUris: [redirectUri],
      }),
    ).toThrow(/dot segments/);
    expect(() =>
      preferredMcpClientRegistration({
        authorizationServer: { clientIdMetadataDocumentSupported: true },
        clientMetadataUrl: metadataUrl,
      }),
    ).toThrow(/dot segments/);
    expect(() =>
      resolveStoredMcpClient(issuer, { kind: "cimd", clientId: metadataUrl }),
    ).toThrow(/dot segments/);
  }
  expect(
    mcpClientIdMetadataDocument({
      metadataUrl: "https://client.example/client.json?v=/../",
      clientName: "client",
      redirectUris: [redirectUri],
    }).client_id,
  ).toBe("https://client.example/client.json?v=/../");
});

test("DCR passes explicit web or native application type to a constraining AS", async () => {
  const Registration = type({
    application_type: "'web' | 'native'",
    redirect_uris: "string[]",
  });
  for (const applicationType of ["web", "native"] as const) {
    const callback =
      applicationType === "web"
        ? "https://client.example/callback"
        : redirectUri;
    const client = await prepareMcpClient({
      entry,
      clientName: "client",
      redirectUri: callback,
      applicationType,
      fetchImpl: async (_input, init) => {
        const body = Registration(JSON.parse(String(init?.body)));
        if (body instanceof type.errors)
          return new Response(null, { status: 400 });
        if (
          body.application_type !== applicationType ||
          body.redirect_uris[0] !== callback
        )
          return new Response(null, { status: 400 });
        return Response.json({ client_id: `${applicationType}-client` });
      },
    });
    expect(client.clientId).toBe(`${applicationType}-client`);
  }
});

test("CIMD rejects normalized alternate authority syntax at every entry point", () => {
  for (const metadataUrl of [
    "https:/client.example/a/b/%2e%2e?v=1",
    "https:client.example/a/b/..?v=1",
    "https:///client.example/client.json",
    "https:////client.example/client.json",
    "https:\\client.example\\client.json",
    "https://client.example/a\\client.json",
    " https://client.example/client.json",
    "https://client.example/client.json ",
    "https://client.example/cl\tient.json",
    "https://client.example/cl\nient.json",
    "https://client.example/client.json\u0000",
    "https://client.example/client.json\u007f",
  ]) {
    expect(() =>
      mcpClientIdMetadataDocument({
        metadataUrl,
        clientName: "client",
        redirectUris: [redirectUri],
      }),
    ).toThrow();
    expect(() =>
      preferredMcpClientRegistration({
        authorizationServer: { clientIdMetadataDocumentSupported: true },
        clientMetadataUrl: metadataUrl,
      }),
    ).toThrow();
    expect(() =>
      resolveStoredMcpClient(issuer, { kind: "cimd", clientId: metadataUrl }),
    ).toThrow();
  }
  for (const metadataUrl of [
    "https://client.example/client.json?v=/../",
    "HTTPS://CLIENT.example:443/client.json?v=1",
    "https://client.example/a%20b/client.json?next=%2F..%2F",
    "https://[2001:db8::1]:8443/client.json",
  ]) {
    expect(
      mcpClientIdMetadataDocument({
        metadataUrl,
        clientName: "client",
        redirectUris: [redirectUri],
      }).client_id,
    ).toBe(metadataUrl);
    expect(
      preferredMcpClientRegistration({
        authorizationServer: { clientIdMetadataDocumentSupported: true },
        clientMetadataUrl: metadataUrl,
      }),
    ).toEqual({ mechanism: "client-id-metadata", clientId: metadataUrl });
    expect(
      resolveStoredMcpClient(issuer, { kind: "cimd", clientId: metadataUrl })
        .clientId,
    ).toBe(metadataUrl);
  }
});
