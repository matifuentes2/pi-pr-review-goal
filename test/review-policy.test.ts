import assert from "node:assert/strict";
import test from "node:test";
import { auditCompletion, evaluateReview } from "../src/review-policy.ts";
import type { CompletionEvidence, Exec } from "../src/review-policy.ts";

const head = "a".repeat(40);
const stale = "b".repeat(40);
const config = { repoRoot: "/repo", prNumber: 7, baseBranch: "main" };
function clean(): CompletionEvidence {
  return { goalId: "goal-1", execution: {
    attemptId: "run-1", goalId: "goal-1", headSha: head, freshContext: true, status: "completed",
    verdict: JSON.stringify({ schemaVersion: 1, attemptId: "run-1", headSha: head, decision: "clean", findings: [] }),
  } };
}

for (const status of ["launch_failed", "runtime_failed", "interrupted", "running"] as const) {
  test(`${status} cannot become a clean review, even with clean output`, () => {
    const e = clean(); e.execution!.status = status; e.execution!.reason = "Unknown subagent model 'openai/gpt-6.1-sol'";
    const result = evaluateReview(e, head);
    assert.equal(result.ok, false); assert.equal(result.status, "review-failed");
    assert.match(result.reason, /Unknown subagent model/);
  });
}
for (const verdict of [undefined, "", "  ", "{}", "null", "[]", "clean", "```json\n{}\n```", "{", JSON.stringify({ decision: "clean" })]) {
  test(`missing/empty/malformed verdict fails closed: ${JSON.stringify(verdict)}`, () => {
    const e = clean(); e.execution!.verdict = verdict;
    assert.equal(evaluateReview(e, head).status, "review-failed");
  });
}
test("missing execution is review-failed", () => assert.equal(evaluateReview({ goalId: "goal-1" }, head).status, "review-failed"));
test("clean successful fresh execution explicitly approves the current head", () => assert.equal(evaluateReview(clean(), head).ok, true));
for (const mutate of [
  (e: CompletionEvidence) => { e.execution!.headSha = stale; },
  (e: CompletionEvidence) => { e.execution!.freshContext = false; },
  (e: CompletionEvidence) => { e.execution!.goalId = "other-goal"; },
  (e: CompletionEvidence) => { e.execution!.attemptId = ""; },
  (e: CompletionEvidence) => { e.execution!.verdict = e.execution!.verdict!.replace(head, stale); },
  (e: CompletionEvidence) => { e.execution!.verdict = e.execution!.verdict!.replace("run-1", "old-run"); },
]) {
  test(`stale or unbound execution fails closed: ${mutate.toString()}`, () => {
    const e = clean(); mutate(e); assert.equal(evaluateReview(e, head).ok, false);
  });
}
for (const [decision, findings, status] of [
  ["changes_requested", ["Fix unsafe completion"], "findings-unresolved"],
  ["clean", ["Fix unsafe completion"], "review-failed"],
  ["changes_requested", [], "review-failed"],
  ["clean", [""], "review-failed"],
  ["unknown", [], "review-failed"],
] as const) {
  test(`verdict consistency: ${decision} / ${JSON.stringify(findings)}`, () => {
    const e = clean(); const v = JSON.parse(e.execution!.verdict!);
    e.execution!.verdict = JSON.stringify({ ...v, decision, findings });
    assert.equal(evaluateReview(e, head).status, status);
  });
}

function commands(options: { checks?: unknown; code?: number; afterHead?: string; afterBase?: string; mergeable?: string } = {}): Exec {
  let reads = 0;
  return async (_cmd, args) => {
    if (args[1] === "checks") return { code: options.code ?? 0, stdout: JSON.stringify(options.checks ?? [{ name: "test", state: "SUCCESS", bucket: "pass" }]) };
    reads++;
    return { code: 0, stdout: JSON.stringify({
      baseRefName: reads > 1 ? options.afterBase ?? "main" : "main",
      headRefOid: reads > 1 ? options.afterHead ?? head : head,
      mergeable: options.mergeable ?? "MERGEABLE",
    }) };
  };
}
test("successful review and green CI pass the audit", async () => assert.equal((await auditCompletion(config, clean(), commands())).ok, true));
test("green CI cannot bypass missing reviewer evidence", async () => assert.equal((await auditCompletion(config, { goalId: "goal-1" }, commands())).status, "review-failed"));
for (const checks of [[], {}, [{ name: "test", bucket: "pending" }], [{ name: "test", bucket: "fail" }], [{ name: "test", bucket: "skipping" }]]) {
  test(`CI is a separate fail-closed gate: ${JSON.stringify(checks)}`, async () => assert.equal((await auditCompletion(config, clean(), commands({ checks }))).status, "ci-blocked"));
}
test("CI command failure blocks completion", async () => assert.equal((await auditCompletion(config, clean(), commands({ code: 1 }))).status, "ci-blocked"));
test("conflicts block completion", async () => assert.equal((await auditCompletion(config, clean(), commands({ mergeable: "CONFLICTING" }))).status, "ci-blocked"));
test("head changes during audit fail closed", async () => assert.equal((await auditCompletion(config, clean(), commands({ afterHead: stale }))).status, "blocked"));
test("base changes during audit fail closed", async () => assert.equal((await auditCompletion(config, clean(), commands({ afterBase: "other" }))).status, "blocked"));
test("metadata error blocks completion", async () => assert.equal((await auditCompletion(config, clean(), async () => { throw new Error("offline"); })).status, "blocked"));
test("truncated metadata blocks completion", async () => assert.equal((await auditCompletion(config, clean(), async () => ({ code: 0, stdout: "{}", truncated: true }))).status, "blocked"));
