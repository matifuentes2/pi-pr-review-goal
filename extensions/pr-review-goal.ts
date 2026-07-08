import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// /pr-review-goal usage contract:
// - Run from inside the target git repo: /pr-review-goal <pr-number>
// - The PR must target exactly develop or dev.
// - Requires gh, pi-subagents, and pi-codex-goal.
// - The command starts a Codex-style goal with no token budget; control it with
//   /goal pause, /goal resume, or /goal clear.
// Persistence and loop state intentionally stay inside pi-codex-goal's normal
// session state. This extension only performs preflights and launches the
// objective; it does not perform fixes, comments, or a separate review loop itself.
const USAGE = "Usage: /pr-review-goal <pr-number>";

function parsePrNumber(args: string | undefined): number | null {
  const trimmed = (args ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return null;

  const prNumber = Number(trimmed);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;

  return prNumber;
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

function buildGoalObjective(repoRoot: string, prNumber: number, baseRefName: "develop" | "dev", initialHeadRefOid: string): string {
  const objective = `Run the automatic PR review/fix/comment loop for PR #${prNumber} in repo ${repoRoot}.

Contract:
- Use the current repo root exactly: ${repoRoot}.
- Preflight: base ${baseRefName}, head ${initialHeadRefOid}; before completion, confirm base is still develop/dev and use latest head SHA.
- Use gh for PR operations, e.g. gh pr view ${prNumber}, gh pr checkout ${prNumber}, comments, pushes, and metadata.
- Parent agent owns orchestration and loop decisions. Use pi-subagents with a fresh-context reviewer subagent each review round.
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
- Merge conflicts are part of this workflow, not a stop condition: when PR status reveals conflicts, update from base, resolve, validate, commit, push, comment as needed, then continue.
- CI/conflict gate: verify latest-head CI with gh pr view ${prNumber} --json headRefOid,mergeStateStatus,mergeable and gh pr checks ${prNumber} --json name,state,bucket,link. Bad/pending checks block completion; fix or wait, then re-check after every push.
- If gh pr checks shows no checks for latest head, do one quick refresh only; before longer waits, inspect mergeStateStatus/mergeable and PR page/status for MERGE_CONFLICTING/DIRTY/UNKNOWN/conflict messages. If conflicts exist, resolve, validate, commit, push, re-check, continue; report only if impossible.
- Repeat fresh review + Codex inspection -> fixes -> validation -> commit/push -> Spanish replies -> CI/conflict gate until no valid concern remains and latest-head CI is green.
- If reviewer reports no valid change requests in the first round, state that zero fix rounds were needed; otherwise do not stop after one review/fix round.

Do not call goal_complete until: latest fresh reviewer has no valid requests; Codex/chatgpt-codex-connector conversations were inspected and no valid concern remains unresolved; fixes are committed/pushed; comments use real Markdown newlines via --body-file with no literal \\n; Spanish replies were posted directly on original Codex/chatgpt-codex-connector comments/threads for addressed valid concerns; conflicts are resolved/pushed, especially if no checks appeared; PR still targets develop/dev; latest-head CI/checks are green with no bad/pending/queued/in_progress; validation evidence was checked.`;

  if (objective.length > 8000) {
    throw new Error("Generated /goal objective exceeds 8000 characters.");
  }

  return objective;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pr-review-goal", {
    description: "Start a pi-goal PR review/fix loop for a PR in the current repo",
    handler: async (args, ctx) => {
      const prNumber = parsePrNumber(args);
      if (prNumber === null) {
        ctx.ui.notify(USAGE, "warning");
        return;
      }

      const repoResult = await exec(pi, "git", ["rev-parse", "--show-toplevel"], ctx.cwd);
      if (repoResult.code !== 0 || !repoResult.stdout?.trim()) {
        ctx.ui.notify("/pr-review-goal must be run inside a git repo.", "warning");
        return;
      }
      const repoRoot = repoResult.stdout.trim();

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

      if (baseRefName !== "develop" && baseRefName !== "dev") {
        ctx.ui.notify(`PR #${prNumber} must target develop or dev; actual target is ${String(baseRefName || "unknown")}.`, "warning");
        return;
      }
      if (typeof headRefOid !== "string" || headRefOid.trim() === "") {
        ctx.ui.notify(`Unable to read PR #${prNumber} head SHA from gh.`, "warning");
        return;
      }

      const allowedBaseRefName = baseRefName;
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
      pi.events.emit("pi-codex-goal:start", { objective });
    },
  });
}
