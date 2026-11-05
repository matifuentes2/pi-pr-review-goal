import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { auditCompletion, POLICY_ID } from "./review-policy.ts";
import type { CompletionEvidence, GateResult, PolicyConfig } from "./review-policy.ts";

// PROPOSED companion API, not provided by today's pi-codex-goal. Absence must
// block this command; never fall back to its objective-only start event.
export const HOST_EVENT = "pi-codex-goal:completion-policy-host:v1";
export interface CompletionPolicyHost {
  apiVersion: 1;
  registerPolicy(id: string, audit: (config: PolicyConfig, evidence: CompletionEvidence) => Promise<GateResult>): void;
  startGoal(request: { objective: string; policy: { id: string; config: PolicyConfig } }): Promise<{
    ok: boolean;
    goalId?: string;
    reason?: string;
  }>;
}

export const HOST_BLOCKER = "blocked: pi-codex-goal does not provide the required completion-policy host v1. " +
  "Its objective-only start API cannot enforce reviewer success. No PR-review goal was started or replaced. " +
  "Companion changes are required; see pi-pr-review-goal/docs/completion-policy.md.";

export function getGuardedHost(pi: ExtensionAPI): CompletionPolicyHost | null {
  let host: CompletionPolicyHost | null = null;
  let replies = 0;
  let accepting = true;
  try {
    // Pi's event bus invokes listeners synchronously. A companion must supply
    // its adapter during this call; late replies cannot enable an unsafe start.
    pi.events.emit(HOST_EVENT, {
      provide(candidate: CompletionPolicyHost) {
        if (!accepting) return;
        replies++;
        if (candidate?.apiVersion === 1 && typeof candidate.registerPolicy === "function" && typeof candidate.startGoal === "function") {
          host = candidate;
        }
      },
    });
  } catch { return null; }
  finally { accepting = false; }
  if (replies !== 1 || !host) return null;
  const registered: CompletionPolicyHost = host;
  try {
    registered.registerPolicy(POLICY_ID, async (config, evidence) => {
      if (!config || typeof config.repoRoot !== "string" || !config.repoRoot.startsWith("/") ||
          !Number.isSafeInteger(config.prNumber) || config.prNumber <= 0 ||
          typeof config.baseBranch !== "string" || !config.baseBranch.trim()) {
        return { ok: false, status: "blocked", reason: "Missing or malformed persisted PR-review policy configuration." };
      }
      return auditCompletion(config, evidence, (command, args, cwd) => pi.exec(command, args, { cwd, timeout: 30000 }));
    });
    return registered;
  } catch { return null; }
}
