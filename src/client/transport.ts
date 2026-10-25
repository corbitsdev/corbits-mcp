import type { McpClientOptions, McpNotification } from "../client.js";
import type {
  McpSubscriptionFilter,
  McpValidationContext,
} from "../protocol/types.js";
export interface McpRequestOptions extends McpClientOptions {
  validation?: McpValidationContext;
}
/** Extensions receive this interface rather than importing the client facade. */
export interface McpRequestTransport {
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<Record<string, unknown>>;
  listen(
    filter: McpSubscriptionFilter,
    observer: (notification: McpNotification) => void,
    options?: McpRequestOptions,
  ): Promise<void>;
}
