import { expect, test } from "bun:test";
import { OAuthDiscoveryError } from "@corbits/oauth-core";
import { assertOAuthUrl, assertRedirectUri, secureOAuthFetch } from "./http.js";
import {
  assertAuthServerUrl,
  assertAuthRedirectUri,
  McpAuthUrlError,
} from "./url-policy.js";

function caught(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected URL validation to fail");
}

test("neutral server URL checks retain OAuth facade validation and diagnostics", () => {
  for (const [raw, issuer] of [
    ["not-a-url", false],
    ["http://127.0.0.1/token", false],
    ["http://internal.example/token", false],
    ["https://user:secret@auth.example/token", false],
    ["https://auth.example/token#secret", false],
    ["https://auth.example/issuer?tenant=one", true],
    ["https://auth.example/issuer?", true],
    ["https://auth.example/a\\b", false],
  ] as const) {
    const neutral = caught(() => assertAuthServerUrl(raw, issuer));
    const oauth = caught(() => assertOAuthUrl(raw, issuer));
    expect(neutral).toBeInstanceOf(McpAuthUrlError);
    expect(oauth).toBeInstanceOf(OAuthDiscoveryError);
    expect(neutral.name).toBe(oauth.name);
    expect(neutral.message).toBe(oauth.message);
    expect(neutral.message).not.toContain("secret");
  }
  for (const raw of [
    "https://auth.example/token?aud=mcp",
    "https://auth.example/issuer",
    "https://[::1]/issuer",
  ]) {
    expect(assertAuthServerUrl(raw).href).toBe(assertOAuthUrl(raw).href);
  }
});

test("redirect facade retains loopback exception and oauth-core error identity", () => {
  for (const raw of [
    "http://127.0.0.1:8080/callback",
    "http://localhost/callback",
    "https://client.example/callback",
  ]) {
    expect(assertAuthRedirectUri(raw).href).toBe(assertRedirectUri(raw).href);
  }
  const neutral = caught(() =>
    assertAuthRedirectUri("http://internal.example/callback"),
  );
  const oauth = caught(() =>
    assertRedirectUri("http://internal.example/callback"),
  );
  expect(neutral.message).toBe(oauth.message);
  expect(oauth).toBeInstanceOf(OAuthDiscoveryError);
});

test("HTTP compatibility facade preserves secure fetch export and redirect error class", async () => {
  const safe = secureOAuthFetch(async (_input, init) => {
    expect(init?.redirect).toBe("error");
    return new Response(null, { status: 307 });
  });
  await expect(safe("https://auth.example/token")).rejects.toBeInstanceOf(
    OAuthDiscoveryError,
  );
});
