import { McpError, assertJsonBounds } from "../protocol/index.js";

/** Both HTTP and SSE errors preserve bounded JSON data, never arbitrary thrown objects. */
export function errorPayload(error: unknown, fallback: string) {
  if (!(error instanceof McpError)) return { code: -32603, message: fallback };
  let data: unknown;
  if (error.data !== undefined) {
    try {
      assertJsonBounds(error.data);
      data = JSON.parse(JSON.stringify(error.data));
    } catch {
      /* Invalid provider error data must not break the response stream. */
    }
  }
  return {
    code: error.code ?? -32603,
    message: error.message,
    ...(data === undefined ? {} : { data }),
  };
}
