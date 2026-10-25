import type { Skill } from "../../protocol/index.js";

/** Host-assigned identities, never serverInfo.name or a bearer token. */
export interface McpSkillOrigin {
  serverId: string;
  tenantId: string;
  principalId: string;
  authorizationContextId: string;
}
export interface HeldSkill {
  readonly origin: Readonly<McpSkillOrigin>;
  readonly entry: Readonly<Skill>;
  readonly identity: string;
  readonly fingerprint: string;
}
export interface SkillApprovalReceipt {
  identity: string;
  fingerprint: string;
  /** Explicit user consent to this skill, not to nested skills. */
  approved: true;
  execution: boolean;
}
export interface VerifiedSkillBytes {
  held: HeldSkill;
  uri: string;
  bytes: Uint8Array;
  /** Always untrusted MCP data; integrity is not authorship or trust. */
  trust: "untrusted-mcp";
}
export interface McpSkillHostPolicy {
  approve(held: HeldSkill): Promise<SkillApprovalReceipt>;
  /** Install an all-code-execution-tool gate before admitting context. */
  openActingWindow(
    held: HeldSkill,
    approval: SkillApprovalReceipt,
    guards: { assertExecutionApproved(): void },
  ): Promise<{
    admit(content: VerifiedSkillBytes): Promise<void>;
    /** Must remove context before returning; do not shorten the acting window. */
    removeContext(): Promise<void>;
    close(): Promise<void>;
  }>;
}
export interface SkillLease {
  readonly held: HeldSkill;
  read(uri: string): Promise<VerifiedSkillBytes>;
  /** Re-check for every host code-execution call; never widens existing grants. */
  assertExecutionApproved(): void;
  release(): Promise<void>;
}
export interface SkillSource {
  /** Must use the origin's mediated transport and shared protocol validation. */
  get(origin: McpSkillOrigin, uri: string): Promise<Skill>;
  /** Decode a single matching resources/read text/blob to raw bytes. Enforce maxBytes while streaming. */
  read(
    origin: McpSkillOrigin,
    uri: string,
    maxBytes: number,
  ): Promise<Uint8Array>;
}
