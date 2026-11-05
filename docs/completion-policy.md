# Reviewer-success completion policy

`pi-pr-review-goal` and the policy-aware `pi-codex-goal` companion implement an
awaited reviewer-success gate. Older objective-only companions remain unsupported:
`/pr-review-goal` reports `blocked` without starting or replacing a goal. There is
no legacy-event fallback, generic tool interception, or model/provider fallback.

## Installation and compatibility

Install both companion revisions together. `companion-ref.json` pins the tested
`matifuentes2/pi-codex-goal` revision; CI checks out that exact commit and tests its
**built `dist/index.js` entrypoint**, not a mock host. The isolated reviewer requires
Pi 1.5+ on PATH (on native Windows the host invokes its installed SDK CLI with Node).
Restart/reload Pi after updating both packages. Updating only this package does
not retrofit the policy boundary into an old companion.

The companion work is linked from PR #1. Merge/deploy the companion before the
consumer; until then the old installation intentionally stays fail-closed.

## Trust boundary and lifecycle

- Protected goals persist `completionPolicy: { id, config }` and host-owned
  `reviewExecution` metadata in ordinary session entries. Generic goals have no
  descriptor and retain their existing behavior.
- `update_goal` awaits the real companion completion boundary. Direct state
  transitions/snapshot writes cannot mark a protected goal complete or strip its
  descriptor/evidence. The persistence layer alone commits successful completion;
  terminal runtime effects happen only after the audit succeeds.
- Missing/malformed policies, exceptions, invalid results, timeout, and aborted
  audits deny completion. Goal/session mutations, policy replacement, newer
  attempts and concurrent completion invalidate in-flight authorizations.
- Accounting, pause/resume, compaction, session reload, tree navigation and forks
  preserve policy metadata. Restore converts running reviews to `interrupted`
  and pauses them. Historical protected completion is restored paused and must be
  re-audited, not grandfathered when its validator is unavailable.
- Clear/replacement cancels a goal, never completes it. Starting a PR-review goal
  does not replace an existing non-complete goal.

Session storage, installed extensions and the local OS are trusted. This is not a
sandbox against a user or agent with unrestricted shell access rewriting extension
code or session journals. No completion tool accepts an uploaded verdict file,
parent-authored execution evidence or an assertion that a reviewer ran.

## Trusted reviewer execution

`/pr-review-goal` resolves the active session's actual provider/model at command
start, validates it in the current registry, and persists it as
`completionPolicy.reviewer`. The optional `--reviewer <provider/model>` flag overrides
that initial selection. The generated objective includes the resolved pair; the
agent must not search chat history or ask the user to choose it again.

Use `run_goal_review({})` to launch the persisted selection. Explicit provider/model
arguments, if supplied, must match it; switching the parent model or retrying after
a failed launch never changes the reviewer. Legacy goals without this field bind
the current resolved model once at their first review (or an explicit pair), so
existing paused goals can recover without manually rewriting session files.
`get_goal` exposes the selection as a structured field, not only buried in the
objective. Initial inheritance is selection, **not** fallback.

The host verifies the model registry before launch, creates its own attempt UUID,
and persists `running` **before** setup. A newer attempt supersedes any earlier
clean result, including when its launch fails.

The registered policy prepares current PR metadata and diff using `gh`; it requires
a clean checkout at the remote PR head and the configured target branch. Metadata
is re-read around preparation and after reviewer execution. The host launches a
new Pi process in a temporary directory, without session history, extensions, MCP,
skills, prompt templates or context files. Only read/grep/find/ls tools are enabled;
there are no write, shell, GitHub or delegation tools. Repository content is data,
not instructions. The reviewer receives the trusted PR diff and absolute source
paths, not the parent's conversation or goal history.

The host captures the actual process exit and authoritative final assistant
message, checks the exact provider/model, and persists the raw final output.
Partial streams, failed/aborted/length-limited responses, missing final messages,
nonzero exits, interrupted processes, timeout and output overflow cannot authorize
completion. Setup/runtime failure pauses an active goal with attention instead of
continuing indefinitely. A retry requires an explicitly chosen model; there is no
automatic fallback. Temporary process directories are removed after termination.

The model's final output must be exactly one JSON object:

```json
{"schemaVersion":1,"attemptId":"<host UUID>","headSha":"<full reviewed SHA>","decision":"clean","findings":[]}
```

`changes_requested` requires nonempty string findings. Unknown keys, missing or
empty output, malformed/contradictory JSON, wrong attempt/goal, non-fresh context,
and stale head SHA deny completion.

## Independent completion audit

`auditCompletion` reads current head/base/mergeability, evaluates the trusted
reviewer execution and verdict, checks latest-head CI, then re-reads PR metadata.
No missing, pending or failed checks are accepted; unknown/conflicting mergeability
blocks completion. Head/base changes during the audit invalidate it. A clean
review cannot replace CI, and green CI cannot replace reviewer success.

| Result | Meaning |
| --- | --- |
| `ready` | Fresh successful execution, explicit clean verdict, current head, green CI, mergeable |
| `review-failed` | Missing/failed execution, invalid verdict, stale attempt/head or wrong provenance |
| `findings-unresolved` | Valid changes-requested verdict; fix and run a new reviewer |
| `ci-blocked` | Missing/pending/failing checks or unknown/conflicting mergeability |
| `blocked` | Missing host/policy, malformed configuration, metadata failure or audit race |

Parent orchestration duties (Codex-thread inspection, evidence-based fixes,
validation, commits/pushes, Spanish replies and comment formatting) remain explicit
workflow instructions. This gate does **not** falsely claim to machine-verify every
one of those duties or automatically merge a PR.

## Adapter

On synchronous `pi-codex-goal:completion-policy-host:v1`, exactly one companion
listener calls `provide(host)`. The host must also advertise
`reviewerSelectionVersion: 1`; older v1 hosts cannot silently start the new
no-argument-reviewer workflow. Late/duplicate providers and registration errors
fail closed. `registerPolicy(id, audit, prepareReview)` supplies trusted callbacks;
`startGoal({objective, policy})` returns an acknowledged goal ID. The companion
owns reviewer launch, ledger capture, persistence and final completion. A shim
that forwards policy-bearing requests to the objective-only event is not valid.

## Validation

- `npm test`: argument/adapter/evaluator regression tests, including CI/head races.
- `PI_CODEX_GOAL_ROOT=/path/to/pi-codex-goal npm run test:integration`: real built
  companion, registered tools, session persistence/restore, subprocess execution,
  success/failure/empty/malformed/stale verdicts, superseded attempts and independent
  CI/head checks. Parent-authored evidence is explicitly rejected.
- The integration suite also runs the installed **real Pi CLI** and SDK transport
  against a loopback OpenAI-compatible protocol fixture. It verifies fresh context,
  read-only tools and successful completion without credentials, paid model calls,
  or launching a real delegated review. Process fixtures cover adverse outcomes;
  they are not described as successful real-model reviews.
- The companion's `npm run verify` covers its real persistence/state boundary,
  direct/manual/API paths, concurrent completion, abort/reload/replacement races,
  policy failures and generic-goal regressions.

No branch protection is changed or bypassed by these tests or this implementation.
