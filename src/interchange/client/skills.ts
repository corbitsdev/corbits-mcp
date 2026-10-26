import { type } from "arktype";
import {
  mcpGetSkill,
  mcpConnect,
  mcpReadResource,
  type McpClientOptions,
} from "../../client.js";
import { validateSkill, MCP_EXT_SKILLS } from "../../protocol/index.js";
import {
  createSkillLoader,
  type McpSkillOrigin,
  type McpSkillHostPolicy,
} from "../../extensions/skills/index.js";

/** This host adapter accepts only one matching text/blob resource. The shared
 * client validates the wire; this narrower shape is the byte-decoder boundary. */
const TextResource = type({ uri: "string", text: "string" });
const BlobResource = type({ uri: "string", blob: "string" });

/** Host-bound skill consumption. Supply a mediated client, never a raw token.
 * Verification alone does not admit model context or authorize execution. */
export function createMcpSkillConsumer(options: {
  origin: McpSkillOrigin;
  url: string;
  client: McpClientOptions;
  host?: McpSkillHostPolicy;
}) {
  const origin = Object.freeze(structuredClone(options.origin));
  const client = {
    ...options.client,
    extensions: [
      ...new Set([...(options.client.extensions ?? []), MCP_EXT_SKILLS]),
    ],
  };
  let ready: Promise<McpClientOptions> | undefined;
  function connect(): Promise<McpClientOptions> {
    ready ??= (async () => ({
      ...client,
      session: client.session ?? (await mcpConnect(options.url, client)),
    }))().catch((cause: unknown) => {
      ready = undefined;
      throw cause;
    });
    return ready;
  }
  const loader = createSkillLoader(
    {
      async get(_origin, uri) {
        const result = await mcpGetSkill(options.url, uri, await connect());
        return validateSkill(result.skill);
      },
      async read(_origin, uri, maxBytes) {
        const result = await mcpReadResource(options.url, uri, {
          ...(await connect()),
          maxDecodedBytes: maxBytes,
        });
        if (result.resultType !== "complete")
          throw new Error(
            "Skill resource requires unsupported host interaction",
          );
        if (result.contents.length !== 1)
          throw new Error(
            "Skill resource must contain exactly one matching item",
          );
        const item = result.contents[0];
        const text = TextResource(item);
        const blob = BlobResource(item);
        let bytes: Uint8Array;
        if (
          !(text instanceof type.errors) &&
          blob instanceof type.errors &&
          text.uri === uri
        ) {
          if (Buffer.byteLength(text.text, "utf8") > maxBytes)
            throw new Error("Skill resource exceeds manifest size");
          bytes = new TextEncoder().encode(text.text);
        } else if (
          !(blob instanceof type.errors) &&
          text instanceof type.errors &&
          blob.uri === uri
        ) {
          // Avoid a repeated-group regex: engines can exhaust their matching
          // budget on valid multi-megabyte blobs. Scan alphabet and padding separately.
          const padding = blob.blob.indexOf("=");
          if (
            blob.blob.length % 4 !== 0 ||
            /[^A-Za-z0-9+/=]/u.test(blob.blob) ||
            (padding !== -1 &&
              (padding < blob.blob.length - 2 ||
                !/^={1,2}$/u.test(blob.blob.slice(padding))))
          )
            throw new Error("Invalid skill resource base64");
          const decodedLength =
            (blob.blob.length / 4) * 3 -
            (blob.blob.endsWith("==") ? 2 : blob.blob.endsWith("=") ? 1 : 0);
          if (decodedLength > maxBytes)
            throw new Error("Skill resource exceeds manifest size");
          bytes = Uint8Array.from(atob(blob.blob), (character) =>
            character.charCodeAt(0),
          );
        } else
          throw new Error(
            "Skill resource must contain matching text or blob bytes",
          );
        if (bytes.byteLength > maxBytes)
          throw new Error("Skill resource exceeds manifest size");
        return bytes;
      },
    },
    options.host,
  );
  return {
    /** Refetching a changed entry invalidates its previous approval. */
    get: (uri: string) => loader.get(origin, uri),
    verify: loader.verify,
    activate: loader.activate,
    clear: loader.clear,
  };
}
