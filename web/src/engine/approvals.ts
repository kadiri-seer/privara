// One-time, expiring approval tokens bound to the exact proposed action (same rules as the gateway).

import { randomHex, sha256Hex } from "./storage";

export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "expired";
export type RejectionReason = "token_invalid" | "token_reused" | "token_expired" | "token_action_mismatch" | "token_agent_mismatch" | "token_not_approved";

export const REJECTION_MESSAGES: Record<RejectionReason, string> = {
  token_invalid: "The approval token isn't recognised.",
  token_reused: "The approval token was already used. Tokens work once.",
  token_expired: "The approval token has expired.",
  token_action_mismatch: "The approval token was issued for a different action or different arguments.",
  token_agent_mismatch: "The approval token was issued to a different agent.",
  token_not_approved: "This request hasn't been approved.",
};

export interface ApprovalRequest {
  id: string;
  agent: string;
  action: string;
  resource: string;
  tool: string | null;
  binding: string;
  summary: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number | null;
  tokenHash: string | null;
}

export class ApprovalRejected extends Error {
  constructor(public reason: RejectionReason) {
    super(REJECTION_MESSAGES[reason]);
  }
}

export class Approvals {
  private requests = new Map<string, ApprovalRequest>();

  constructor(
    public ttlMs = 5 * 60_000,
    public pendingTtlMs = 60 * 60_000,
    private now: () => number = () => Date.now(),
  ) {}

  setClock(now: () => number) {
    this.now = now;
  }

  private refresh(r: ApprovalRequest): ApprovalRequest {
    const t = this.now();
    if ((r.status === "pending" && t > r.createdAt + this.pendingTtlMs) || (r.status === "approved" && r.expiresAt && t > r.expiresAt)) {
      r.status = "expired";
    }
    return r;
  }

  create(input: Pick<ApprovalRequest, "agent" | "action" | "resource" | "tool" | "binding" | "summary">): ApprovalRequest {
    const request: ApprovalRequest = { ...input, id: "apr_" + randomHex(6), status: "pending", createdAt: this.now(), expiresAt: null, tokenHash: null };
    this.requests.set(request.id, request);
    return { ...request };
  }

  get(id: string): ApprovalRequest | undefined {
    const r = this.requests.get(id);
    return r ? { ...this.refresh(r) } : undefined;
  }

  list(): ApprovalRequest[] {
    return [...this.requests.values()].map((r) => ({ ...this.refresh(r) })).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** A person approves: returns the single-use token. Only its hash is kept. */
  async approve(id: string): Promise<string> {
    const r = this.requests.get(id);
    if (!r || this.refresh(r).status !== "pending") throw new Error("This request is no longer waiting for a decision.");
    const token = "pv_appr_" + randomHex(24);
    r.status = "approved";
    r.expiresAt = this.now() + this.ttlMs;
    r.tokenHash = await sha256Hex(token);
    return token;
  }

  deny(id: string) {
    const r = this.requests.get(id);
    if (!r || this.refresh(r).status !== "pending") throw new Error("This request is no longer waiting for a decision.");
    r.status = "denied";
  }

  async consume(agent: string, token: string, binding: string): Promise<ApprovalRequest> {
    const hash = await sha256Hex(token);
    const r = [...this.requests.values()].find((x) => x.tokenHash === hash);
    if (!r) throw new ApprovalRejected("token_invalid");
    this.refresh(r);
    if (r.agent !== agent) throw new ApprovalRejected("token_agent_mismatch");
    if (r.status === "consumed") throw new ApprovalRejected("token_reused");
    if (r.status === "expired") throw new ApprovalRejected("token_expired");
    if (r.status !== "approved") throw new ApprovalRejected("token_not_approved");
    if (r.binding !== binding) throw new ApprovalRejected("token_action_mismatch");
    r.status = "consumed";
    return { ...r };
  }
}
