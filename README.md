# pi-pr-review-goal

Private Pi package providing the `/pr-review-goal` extension.

## Install

```bash
pi install git:github.com/matifuentes2/pi-pr-review-goal
```

## Command

```bash
/pr-review-goal <pr-number> [--base <branch>]
```

Starts a Codex-style PR review/fix/comment loop for a GitHub PR.

- Without `--base`, the PR must target `develop` or `dev` (backward-compatible default).
- With `--base <branch>` (or `-b <branch>` / `--base=<branch>`), the PR must target that branch exactly.

Example:

```bash
/pr-review-goal 123 --base main
```
