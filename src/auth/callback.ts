import type { CallbackServer } from "@corbits/oauth-core";
import { OAuthDiscoveryError } from "@corbits/oauth-core";
import {
  assertAuthorizationCallbackIssuer,
  readAuthorizationCallback,
  type AuthorizationIssuerOptions,
} from "../oauth-discovery.js";
import { assertRedirectUri } from "./http.js";

/** Fetch-compatible receiver implementing oauth-core's injected CallbackServer.
 * The host MUST bind exactly redirectUri before returning this adapter from
 * startCallbackServer, and MUST stop that listener from closeListener.
 * Unlike the stock callback server this checks iss before returning a code. */
export function createMcpCallbackAdapter(opts: {
  expectedState: string;
  redirectUri: string;
  issuer: Omit<AuthorizationIssuerOptions, "iss">;
  closeListener(): void;
}): CallbackServer & { fetch(request: Request): Response } {
  const redirect = assertRedirectUri(opts.redirectUri);
  let outcome: { code: string } | { error: Error } | undefined;
  let notify: (() => void) | undefined;
  let closed = false;
  return {
    port: Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80)),
    fetch(request) {
      const url = new URL(request.url);
      if (
        request.method !== "GET" ||
        url.origin !== redirect.origin ||
        url.pathname !== redirect.pathname
      )
        return new Response(null, { status: 404 });
      if (closed || outcome !== undefined)
        return new Response(null, { status: 409 });
      if (
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.get("state") !== opts.expectedState
      )
        return new Response("Invalid authorization response", { status: 400 });
      try {
        assertAuthorizationCallbackIssuer(url.searchParams, opts.issuer);
      } catch {
        // Unauthenticated attempts must not terminate the legitimate login.
        return new Response("Invalid authorization response", { status: 400 });
      }
      try {
        outcome = readAuthorizationCallback(url.searchParams, opts.issuer);
        notify?.();
        return new Response(
          "Authorization received. You may close this window.",
          {
            headers: {
              "cache-control": "no-store",
              "content-type": "text/plain",
            },
          },
        );
      } catch {
        outcome = {
          error: new OAuthDiscoveryError("Invalid authorization response"),
        };
        notify?.();
        return new Response("Invalid authorization response", { status: 400 });
      }
    },
    async waitForCode(signal) {
      signal.throwIfAborted();
      if (outcome === undefined)
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            notify = undefined;
            reject(new OAuthDiscoveryError("Authorization cancelled"));
          };
          notify = () => {
            signal.removeEventListener("abort", abort);
            notify = undefined;
            resolve();
          };
          signal.addEventListener("abort", abort, { once: true });
        });
      if (outcome === undefined || "error" in outcome)
        throw (
          outcome?.error ?? new OAuthDiscoveryError("Authorization cancelled")
        );
      return outcome.code;
    },
    close() {
      if (closed) return;
      closed = true;
      outcome ??= { error: new OAuthDiscoveryError("Authorization cancelled") };
      notify?.();
      opts.closeListener();
    },
  };
}
