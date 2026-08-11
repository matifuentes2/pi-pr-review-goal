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

Starts a Codex-style PR review/fix/comment loop for a GitHub PR.

- Without `--base`, the PR must target `develop` or `dev` (backward-compatible default).
- With `--base <branch>` (or `-b <branch>` / `--base=<branch>`), the PR must target that branch exactly.

Example:

```bash
/pr-review-goal 123 --base main
```

## Operational safety

The generated goal can use the caller's local Git and GitHub credentials to check out branches, modify code, commit, push, and post PR comments. Run it only in repositories where those automated changes are intended, review its output, and rely on branch protection and required CI checks for remote safeguards.

## License

MIT
