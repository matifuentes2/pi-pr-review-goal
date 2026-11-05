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

> **Currently blocked:** the inspected companion exposes only an objective-text start event, not an enforceable completion-policy API. This version refuses to start or replace a goal through that unsafe API. The policy evaluator and proposed adapter are implemented here, but the required companion completion-boundary and trusted reviewer-execution integration are not. See [the concrete blocker, proposed contract, and test limitations](docs/completion-policy.md). This is not an end-to-end reviewer-success gate release.

- Without `--base`, the PR must target `develop` or `dev` (backward-compatible default).
- With `--base <branch>` (or `-b <branch>` / `--base=<branch>`), the PR must target that branch exactly.

Example:

```bash
/pr-review-goal 123 --base main
```

## Validation

Run `npm test` on Node 22.18+ or 24. Tests use the built-in test runner and no added dependencies. Mock adapter tests do not establish enforcement in the real companion.

## Operational safety

The generated goal can use the caller's local Git and GitHub credentials to check out branches, modify code, commit, push, and post PR comments. Run it only in repositories where those automated changes are intended, review its output, and rely on branch protection and required CI checks for remote safeguards.

## License

MIT
