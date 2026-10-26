import { expect, test } from "bun:test";
import { createMcpCallbackAdapter } from "./callback.js";
import { secureOAuthFetch } from "./http.js";
import {
  discoverMcpLoginEntry,
  registerMcpClient,
} from "../oauth-discovery.js";

const redirectUri = "http://127.0.0.1:8080/callback";
test("callback adapter buffers early success and validates issuer before yielding code", async () => {
  for (const iss of ["https://auth.example", "https://other.example"]) {
    let closed = false;
    const receiver = createMcpCallbackAdapter({
      expectedState: "state",
      redirectUri,
      issuer: { recordedIssuer: "https://auth.example" },
      closeListener: () => {
        closed = true;
      },
    });
    expect(
      receiver.fetch(new Request(`${redirectUri}?state=wrong&code=code`))
        .status,
    ).toBe(400);
    const response = receiver.fetch(
      new Request(`${redirectUri}?state=state&code=code&iss=${iss}`),
    );
    if (iss === "https://auth.example") {
      expect(response.status).toBe(200);
      expect(await receiver.waitForCode(new AbortController().signal)).toBe(
        "code",
      );
    } else {
      expect(response.status).toBe(400);
      expect(
        receiver.fetch(
          new Request(
            `${redirectUri}?state=state&code=legitimate&iss=https://auth.example`,
          ),
        ).status,
      ).toBe(200);
      expect(await receiver.waitForCode(new AbortController().signal)).toBe(
        "legitimate",
      );
    }
    receiver.close();
    expect(closed).toBe(true);
  }
});

test("callback adapter close and abort settle pending waiters", async () => {
  const receiver = createMcpCallbackAdapter({
    expectedState: "state",
    redirectUri,
    issuer: { recordedIssuer: "https://auth.example" },
    closeListener() {},
  });
  const waiting = receiver.waitForCode(new AbortController().signal);
  receiver.close();
  await expect(waiting).rejects.toThrow(/cancelled/);
});

test("OAuth endpoints refuse HTTP, userinfo, fragments, and redirects without leaking errors", async () => {
  for (const endpoint of [
    "http://auth.example/token",
    "http://127.0.0.1/token",
    "https://user:private@auth.example/token",
    "https://auth.example/token#private",
  ]) {
    let called = false;
    await expect(
      secureOAuthFetch(async () => {
        called = true;
        return Response.json({});
      })(endpoint),
    ).rejects.toThrow();
    expect(called).toBe(false);
  }
  const fetchImpl = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    expect(init?.redirect).toBe("error");
    return new Response(null, {
      status: 307,
      headers: { location: "https://other.example" },
    });
  };
  await expect(
    secureOAuthFetch(fetchImpl)("https://auth.example/token"),
  ).rejects.toThrow(/redirect/);
  await expect(
    discoverMcpLoginEntry({
      resourceUrl: "https://mcp.example/mcp",
      fetchImpl,
    }),
  ).rejects.toThrow(/redirect/);
  await expect(
    registerMcpClient({
      registrationEndpoint: "https://auth.example/register",
      clientName: "client",
      redirectUris: [redirectUri],
      fetchImpl,
    }),
  ).rejects.toThrow();
});

test("adapter composes with installed oauth-core login and staged commit", async () => {
  const { startOAuthLogin } = await import("@corbits/oauth-core");
  let receiver: ReturnType<typeof createMcpCallbackAdapter> | undefined;
  let saved = false;
  let closed = false;
  const login = await startOAuthLogin(
    { profile: "profile", signal: new AbortController().signal },
    {
      startCallbackServer: async (state) => {
        receiver = createMcpCallbackAdapter({
          expectedState: state,
          redirectUri,
          issuer: {
            recordedIssuer: "https://auth.example",
            authorizationResponseIssParameterSupported: true,
          },
          closeListener: () => {
            closed = true;
          },
        });
        return receiver;
      },
      buildAuthorizeUrl: (pkce, state) => {
        expect(pkce.method).toBe("S256");
        return `https://auth.example/authorize?state=${state}`;
      },
      openInBrowser: (url) => {
        const state = new URL(url).searchParams.get("state");
        expect(
          receiver?.fetch(
            new Request(
              `${redirectUri}?state=${state}&iss=https://auth.example&code=code`,
            ),
          ).status,
        ).toBe(200);
      },
      exchangeCode: async (code, verifier) => {
        expect(code).toBe("code");
        expect(verifier.length).toBeGreaterThanOrEqual(43);
        return { access: "access", refresh: "refresh" };
      },
      saveProfile: async () => {
        saved = true;
      },
    },
  );
  const staged = await login.completed;
  expect(closed).toBe(true);
  expect(saved).toBe(false);
  await staged.commit();
  expect(saved).toBe(true);
});
