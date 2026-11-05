import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGuardedHost, HOST_BLOCKER } from "../src/goal-host.ts";
import { POLICY_ID } from "../src/review-policy.ts";

// /pr-review-goal usage contract:
// - Run from inside the target git repo: /pr-review-goal <pr-number> [--base <branch>]
// - Without --base, the PR must target exactly develop or dev (legacy behavior).
// - With --base, the PR must target exactly the specified branch.
// - Requires gh and a completion-policy-aware pi-codex-goal.
// - The command starts a Codex-style goal with no token budget; control it with
//   /goal pause, /goal resume, or /goal clear.
// Persistence and loop state stay inside pi-codex-goal. Starting requires a
// completion-policy host, not just an objective-only event listener. Older
// companions fail closed rather than silently dropping the protection.
const USAGE = "Usage: /pr-review-goal <pr-number> [--base <branch>]";

type PrReviewOptions = {
  prNumber: number;
  baseBranch?: string;
};

function unquote(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, "$2");
}

export function parseArgs(args: string | undefined): PrReviewOptions | null {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  let prNumber: number | undefined;
  let baseBranch: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = unquote(tokens[index] ?? "");

    if (token === "--base" || token === "-b") {
      if (baseBranch !== undefined) return null;
      const next = tokens[index + 1];
      if (!next) return null;
      baseBranch = unquote(next).trim();
      index += 1;
      continue;
    }

    if (token.startsWith("--base=")) {
      if (baseBranch !== undefined) return null;
      baseBranch = unquote(token.slice("--base=".length)).trim();
      continue;
    }

    if (token.startsWith("-") || prNumber !== undefined || !/^\d+$/.test(token)) return null;

    const parsedPrNumber = Number(token);
    if (!Number.isSafeInteger(parsedPrNumber) || parsedPrNumber <= 0) return null;
    prNumber = parsedPrNumber;
  }

  if (prNumber === undefined || baseBranch === "") return null;
  return { prNumber, baseBranch };
}

type ExecResult = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  killed?: boolean;
};

async function exec(pi: ExtensionAPI, command: string, args: string[], cwd: string): Promise<ExecResult> {
  return pi.exec(command, args, { cwd, timeout: 30000 }) as Promise<ExecResult>;
}

function buildGoalObjective(repoRoot: string, prNumber: number, baseRefName: string, initialHeadRefOid: string): string {
  const objective = `Run the automatic PR review/fix/comment loop for PR #${prNumber} in repo ${repoRoot}.

Contract:
- Use the current repo root exactly: ${repoRoot}.
- The required PR target/base branch is exactly ${baseRefName}.
- Preflight: base ${baseRefName}, head ${initialHeadRefOid}; before completion, confirm base is still exactly ${baseRefName} and use latest head SHA.
- Use gh for PR operations, e.g. gh pr view ${prNumber}, gh pr checkout ${prNumber}, comments, pushes, and metadata.
- Parent agent owns orchestration and loop decisions. Run run_goal_review with the explicitly requested exact provider and model each review round. This host-owned, fresh-context, read-only reviewer is the only accepted execution evidence; ordinary subagent summaries or verdict files do not authorize completion.
- The goal host must capture actual reviewer execution status separately from findings and CI. Setup/launch/runtime failures or interruptions are review-failed, never a clean review. Do not switch models or providers as a fallback.
- Reviewer final output must be exactly one JSON object: {"schemaVersion":1,"attemptId":"<host attempt ID>","headSha":"<reviewed full SHA>","decision":"clean" or "changes_requested","findings":["required finding"]}. A clean verdict requires an empty findings array. Missing, empty, malformed, contradictory or stale verdicts block completion.
- Inspect PR review comments/conversations from chatgpt-codex-connector/Codex if present via gh/gh api, including review threads and issue comments. Valid evidence-backed Codex concerns are required fixes.
- For every addressed chatgpt-codex-connector/Codex concern, identify the exact original GitHub comment/thread and reply directly to that comment/thread; do not satisfy it with only a new top-level PR comment.
- Iterate at parent level: review, inspect Codex threads/comments, fix valid corrections, validate, commit, push, direct-reply/comment, then start a brand-new reviewer on the updated PR diff.
- Treat only evidence-backed, valid reviewer or Codex concerns as required fixes.
- Use one writer path at a time for fixes.
- After fixes, run focused validation, commit, and push.
- Post a PR comment in Spanish for each pushed fix round summarizing changes and validation, preserving technical jargon in English.
- For each addressed valid Codex/chatgpt-codex-connector concern, reply in Spanish directly to the original Codex-initiated review thread or comment explaining the fix, preserving technical jargon in English; only use top-level PR comments for the round summary, not as a substitute for direct connector replies.
- IMPORTANT comment formatting: GitHub comments must contain real Markdown line breaks, never literal escaped sequences like \\n. Write each PR comment to a temporary .md file with a heredoc or printf that produces actual newlines, inspect the file, then post with gh pr comment ${prNumber} --body-file <file>. Do not use gh pr comment --body "...\\n..." or any command form that can render backslash-n text.
- Before posting each comment, verify the body file is readable Markdown with headings/lists and contains no literal \\n sequences.
- Merge conflicts are part of this workflow, not a stop condition: when PR status reveals conflicts, update from target base ${baseRefName}, resolve, validate, commit, push, comment as needed, then continue.
- CI/conflict gate: verify latest-head CI with gh pr view ${prNumber} --json headRefOid,mergeStateStatus,mergeable and gh pr checks ${prNumber} --json name,state,bucket,link. Bad/pending checks block completion; fix or wait, then re-check after every push.
- If gh pr checks shows no checks for latest head, do one quick refresh only; before longer waits, inspect mergeStateStatus/mergeable and PR page/status for MERGE_CONFLICTING/DIRTY/UNKNOWN/conflict messages. If conflicts exist, resolve, validate, commit, push, re-check, continue; report only if impossible.
- Repeat fresh review + Codex inspection -> fixes -> validation -> commit/push -> Spanish replies -> CI/conflict gate until no valid concern remains and latest-head CI is green.
- If reviewer reports no valid change requests in the first round, state that zero fix rounds were needed; otherwise do not stop after one review/fix round.

Do not call update_goal(status: complete) until: latest fresh reviewer has no valid requests; Codex/chatgpt-codex-connector conversations were inspected and no valid concern remains unresolved; fixes are committed/pushed; comments use real Markdown newlines via --body-file with no literal \\n; Spanish replies were posted directly on original Codex/chatgpt-codex-connector comments/threads for addressed valid concerns; conflicts are resolved/pushed, especially if no checks appeared; PR still targets exactly ${baseRefName}; latest-head CI/checks are green with no bad/pending/queued/in_progress; validation evidence was checked.`;

  if (objective.length > 8000) {
    throw new Error("Generated /goal objective exceeds 8000 characters.");
  }

  return objective;
}

export default function (pi: ExtensionAPI) {
  // Re-register the policy after reload/session replacement. The companion must
  // deny completion for restored protected goals until their policy is resolved.
  pi.on("session_start", () => { getGuardedHost(pi); });

  pi.registerCommand("pr-review-goal", {
    description: "Start a PR review/fix goal; optionally require a target branch with --base",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      if (parsed === null) {
        ctx.ui.notify(USAGE, "warning");
        return;
      }
      const { prNumber, baseBranch: requestedBaseBranch } = parsed;
      const host = getGuardedHost(pi);
      if (!host) {
        ctx.ui.notify(HOST_BLOCKER, "error");
        return;
      }

      const repoResult = await exec(pi, "git", ["rev-parse", "--show-toplevel"], ctx.cwd);
      if (repoResult.code !== 0 || !repoResult.stdout?.trim()) {
        ctx.ui.notify("/pr-review-goal must be run inside a git repo.", "warning");
        return;
      }
      const repoRoot = repoResult.stdout.trim();

      if (requestedBaseBranch) {
        const branchResult = await exec(pi, "git", ["check-ref-format", "--branch", requestedBaseBranch], repoRoot);
        if (branchResult.code !== 0) {
          ctx.ui.notify(`Invalid target branch: ${requestedBaseBranch}.`, "warning");
          return;
        }
      }

      const ghResult = await exec(pi, "gh", ["--version"], repoRoot);
      if (ghResult.code !== 0) {
        ctx.ui.notify("gh CLI is required for PR metadata and commenting.", "warning");
        return;
      }

      const prResult = await exec(pi, "gh", ["pr", "view", String(prNumber), "--json", "baseRefName,headRefOid"], repoRoot);
      if (prResult.code !== 0 || !prResult.stdout?.trim()) {
        ctx.ui.notify(`Unable to read PR #${prNumber} metadata with gh.`, "warning");
        return;
      }

      let baseRefName: unknown;
      let headRefOid: unknown;
      try {
        const prMetadata = JSON.parse(prResult.stdout);
        baseRefName = prMetadata.baseRefName;
        headRefOid = prMetadata.headRefOid;
      } catch {
        ctx.ui.notify(`Unable to parse PR #${prNumber} metadata from gh.`, "warning");
        return;
      }

      let allowedBaseRefName: string;
      if (requestedBaseBranch) {
        if (baseRefName !== requestedBaseBranch) {
          ctx.ui.notify(`PR #${prNumber} must target ${requestedBaseBranch}; actual target is ${String(baseRefName || "unknown")}.`, "warning");
          return;
        }
        allowedBaseRefName = requestedBaseBranch;
      } else {
        if (baseRefName !== "develop" && baseRefName !== "dev") {
          ctx.ui.notify(`PR #${prNumber} must target develop or dev; actual target is ${String(baseRefName || "unknown")}. Pass --base <branch> to allow another target.`, "warning");
          return;
        }
        allowedBaseRefName = baseRefName;
      }
      if (typeof headRefOid !== "string" || headRefOid.trim() === "") {
        ctx.ui.notify(`Unable to read PR #${prNumber} head SHA from gh.`, "warning");
        return;
      }

      const initialHeadRefOid = headRefOid.trim();

      const goalCommand = pi.getCommands().find((command) => {
        const path = command.sourceInfo?.path ?? "";
        return command.name.startsWith("goal") && path.includes("pi-codex-goal");
      });
      if (!goalCommand) {
        ctx.ui.notify("pi-codex-goal must be installed/enabled before using /pr-review-goal.", "warning");
        return;
      }

      const objective = buildGoalObjective(repoRoot, prNumber, allowedBaseRefName, initialHeadRefOid);
      try {
        const result = await host.startGoal({
          objective,
          policy: { id: POLICY_ID, config: { repoRoot, prNumber, baseBranch: allowedBaseRefName } },
        });
        if (result?.ok !== true || typeof result.goalId !== "string" || !result.goalId.trim()) {
          ctx.ui.notify(`blocked: guarded PR-review goal was not acknowledged: ${result?.reason || "missing goal ID or rejected policy"}.`, "error");
        }
      } catch (error) {
        ctx.ui.notify(`blocked: guarded PR-review goal start failed: ${error instanceof Error ? error.message : String(error)}.`, "error");
      }
    },
  });
}
