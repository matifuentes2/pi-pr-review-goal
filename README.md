# pi-pr-review-goal

A [Pi coding agent](https://github.com/earendil-works/pi) package providing the `/pr-review-goal` extension.

## Install

```bash
pi install git:github.com/matifuentes2/pi-pr-review-goal
```

## Command

```bash
/pr-review-goal <pr-number> [--base <branch>]
```

Starts a Codex-style PR review/fix/comment loop for a GitHub PR **only with a completion-policy-capable `pi-codex-goal` host**.

Install the matching policy-aware `pi-codex-goal` revision from `companion-ref.json` and use Pi 1.5+. Older objective-only companions fail closed without replacing your current goal. See [the completion boundary, trust model, and integration tests](docs/completion-policy.md).

Each round uses `run_goal_review({ provider, model })` with the exact explicitly selected provider/model. The companion launches a fresh read-only reviewer and captures its real execution and final verdict; parent-written summaries cannot authorize completion. Setup/runtime failure pauses the goal without model fallback. Completion independently requires a fresh clean verdict, current PR head/base, passing CI and mergeability.

- Without `--base`, the PR must target `develop` or `dev` (backward-compatible default).
- With `--base <branch>` (or `-b <branch>` / `--base=<branch>`), the PR must target that branch exactly.

Example:

```bash
/pr-review-goal 123 --base main
```

## Validation

Run `npm test` on Node 24. To test the real built companion, run its `npm ci --ignore-scripts && npm run build`, then `PI_CODEX_GOAL_ROOT=/path/to/pi-codex-goal npm run test:integration`. The latter includes real Pi CLI execution against a local protocol fixture; it needs Pi 1.5+ on PATH but no model credentials. CI runs both suites against the exact pinned companion commit.

## Operational safety

The generated goal can use the caller's local Git and GitHub credentials to check out branches, modify code, commit, push, and post PR comments. Run it only in repositories where those automated changes are intended, review its output, and rely on branch protection and required CI checks for remote safeguards.

## License

MIT
