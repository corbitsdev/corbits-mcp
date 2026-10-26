// OAuth-only compatibility facade. Neutral server code uses url-policy directly.
export {
  assertOAuthUrl,
  assertRedirectUri,
  secureOAuthFetch,
} from "./oauth-http.js";
export type { FetchLike } from "../protocol/types.js";
