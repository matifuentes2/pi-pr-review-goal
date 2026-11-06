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

// GitHub accepts SUCCESS, NEUTRAL and job-level SKIPPED conclusions. A skipped
// dependent job must not hide its failing/pending prerequisite: inspect every row
// and require at least one passing check, rather than accepting all-skipped CI.
// Keep the state/bucket pairs strict so malformed or contradictory data fails closed.
function evaluateChecks(rows: unknown): GateResult {
  if (!Array.isArray(rows) || rows.length === 0) {
    return reject("ci-blocked", "Latest-head CI has no checks or malformed check data.");
  }
  let passing = 0;
  let skipped = 0;
  const blockers: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.name !== "string" || !row.name.trim()) {
      blockers.push("malformed check");
    } else if (row.bucket === "pass" && (row.state === "SUCCESS" || row.state === "NEUTRAL")) {
      passing++;
    } else if (row.bucket === "skipping" && row.state === "SKIPPED") {
      skipped++;
    } else {
      blockers.push(`${JSON.stringify(row.name.slice(0, 80))} (state=${JSON.stringify(row.state)}, bucket=${JSON.stringify(row.bucket)})`);
    }
  }
  if (blockers.length) {
    return reject("ci-blocked", `Latest-head CI has ${blockers.length} blocking or malformed check(s): ${blockers.slice(0, 5).join("; ")}.`);
  }
  if (passing === 0) return reject("ci-blocked", "Latest-head CI has only skipped checks; at least one passing check is required.");
  return { ok: true, status: "ready", reason: `Latest-head CI: ${passing} passing, ${skipped} skipped.` };
}

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
    // gh uses 1 for failed checks and 8 for pending checks. Inspect their rows for
    // actionable diagnostics, but never accept a nonzero exit even if rows look green.
    if (checks.killed || checks.truncated || ![0, 1, 8].includes(checks.code ?? -1)) {
      return reject("ci-blocked", "Unable to confirm green latest-head CI.");
    }
    let rows: unknown;
    try { rows = JSON.parse(checks.stdout || ""); }
    catch { return reject("ci-blocked", "Unable to parse latest-head CI checks."); }
    const ci = evaluateChecks(rows);
    if (!ci.ok) return ci;
    if (checks.code !== 0) return reject("ci-blocked", `GitHub CLI reported unsuccessful CI (exit ${checks.code}) despite nonblocking-looking checks.`);
    const after = await metadata();
    if (after.headRefOid !== before.headRefOid || after.baseRefName !== config.baseBranch) {
      return reject("blocked", "PR head or base changed during completion audit; re-review current head.");
    }
    if (after.mergeable !== "MERGEABLE") return reject("ci-blocked", "PR mergeability changed during audit.");
    return { ...review, reason: `${review.reason} ${ci.reason}` };
  } catch (error) {
    return reject("blocked", `Completion audit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
