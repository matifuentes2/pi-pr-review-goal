// This policy consumes execution evidence supplied by a trusted goal host, never
// an LLM's assertion that a review ran. See docs/completion-policy.md.
export const POLICY_ID = "pi-pr-review-goal/reviewer-success/v1";

export type PolicyConfig = { repoRoot: string; prNumber: number; baseBranch: string };
export type ReviewExecution = {
  attemptId: string;
  goalId: string;
  headSha: string;
  freshContext: boolean;
  status: "completed" | "launch_failed" | "runtime_failed" | "interrupted" | "running";
  reason?: string;
  // Raw final reviewer output, not a parent-authored summary or partial stream.
  verdict?: string;
};
export type CompletionEvidence = { goalId: string; execution?: ReviewExecution };
export type GateResult = {
  ok: boolean;
  status: "ready" | "blocked" | "review-failed" | "findings-unresolved" | "ci-blocked";
  reason: string;
};

const sha = /^[a-f0-9]{40}$/;
const reject = (status: GateResult["status"], reason: string): GateResult => ({ ok: false, status, reason });

export function evaluateReview(evidence: CompletionEvidence, currentHead: string): GateResult {
  if (!sha.test(currentHead)) return reject("blocked", "Missing or invalid current PR head SHA.");
  const run = evidence.execution;
  if (!run) return reject("review-failed", "No fresh reviewer execution evidence.");
  if (!run.attemptId?.trim() || !evidence.goalId || run.goalId !== evidence.goalId || run.freshContext !== true) {
    return reject("review-failed", "Reviewer execution is not a fresh attempt for this goal.");
  }
  if (run.status !== "completed") {
    return reject("review-failed", `Reviewer execution ${run.status || "missing status"}: ${run.reason || "no successful execution"}.`);
  }
  if (run.headSha !== currentHead) return reject("review-failed", "Reviewer execution is stale for current PR head.");
  if (typeof run.verdict !== "string" || !run.verdict.trim()) {
    return reject("review-failed", "Reviewer verdict is missing or empty.");
  }
  let verdict: unknown;
  try { verdict = JSON.parse(run.verdict); }
  catch { return reject("review-failed", "Reviewer verdict is not a JSON object."); }
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
    return reject("review-failed", "Malformed reviewer verdict.");
  }
  const v = verdict as Record<string, unknown>;
  if (v.schemaVersion !== 1 || v.attemptId !== run.attemptId || v.headSha !== currentHead ||
      (v.decision !== "clean" && v.decision !== "changes_requested") ||
      !Array.isArray(v.findings) || !v.findings.every(f => typeof f === "string" && f.trim().length > 0) ||
      Object.keys(v).sort().join(",") !== "attemptId,decision,findings,headSha,schemaVersion") {
    return reject("review-failed", "Malformed verdict or mismatched attempt/head SHA.");
  }
  if (v.decision === "clean" && v.findings.length > 0) {
    return reject("review-failed", "Clean verdict contradicts nonempty findings.");
  }
  if (v.decision === "changes_requested") {
    return v.findings.length > 0
      ? reject("findings-unresolved", "Reviewer has unresolved findings; fix and run a new reviewer.")
      : reject("review-failed", "Changes-requested verdict has no findings.");
  }
  return { ok: true, status: "ready", reason: "Successful fresh reviewer explicitly approved current PR head." };
}

export type Exec = (command: string, args: string[], cwd: string) => Promise<{
  code?: number | null; stdout?: string; killed?: boolean; truncated?: boolean;
}>;

// CI is a separate gate: success cannot substitute for execution or verdict.
export async function auditCompletion(config: PolicyConfig, evidence: CompletionEvidence, exec: Exec): Promise<GateResult> {
  try {
    const metadata = async () => {
      const result = await exec("gh", ["pr", "view", String(config.prNumber), "--json", "baseRefName,headRefOid,mergeable"], config.repoRoot);
      if (result.code !== 0 || result.killed || result.truncated) throw new Error("Unable to read current PR metadata.");
      return JSON.parse(result.stdout || "");
    };
    const before = await metadata();
    if (before.baseRefName !== config.baseBranch) return reject("blocked", "PR target branch changed.");
    const review = evaluateReview(evidence, before.headRefOid);
    if (!review.ok) return review;
    if (before.mergeable !== "MERGEABLE") return reject("ci-blocked", "PR has conflicts or unknown mergeability.");
    const checks = await exec("gh", ["pr", "checks", String(config.prNumber), "--json", "name,state,bucket,link"], config.repoRoot);
    if (checks.code !== 0 || checks.killed || checks.truncated) return reject("ci-blocked", "Unable to confirm green latest-head CI.");
    const rows: unknown = JSON.parse(checks.stdout || "");
    if (!Array.isArray(rows) || rows.length === 0 || !rows.every(r => r && typeof r.name === "string" && r.bucket === "pass")) {
      return reject("ci-blocked", "Latest-head CI is missing, malformed, pending, or not all passing.");
    }
    const after = await metadata();
    if (after.headRefOid !== before.headRefOid || after.baseRefName !== config.baseBranch) {
      return reject("blocked", "PR head or base changed during completion audit; re-review current head.");
    }
    if (after.mergeable !== "MERGEABLE") return reject("ci-blocked", "PR mergeability changed during audit.");
    return review;
  } catch (error) {
    return reject("blocked", `Completion audit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
