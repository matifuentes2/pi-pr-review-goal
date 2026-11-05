# Reviewer-success completion policy — companion blocker

## Delivery status

**The end-to-end gate is not implemented in the current `pi-codex-goal`.**
This package now refuses to start an unprotected PR-review goal. Its policy
implementation and adapter contract are tested locally, but the adapter API below
is **proposed**, not an existing supported companion API. With the current
companion, `/pr-review-goal` reports `blocked` and leaves any existing goal alone.
Do not treat this change as restoration of the automatic review workflow.

No models, providers, authentication, branch protections or generic goal tools
are modified. There is no fallback to the legacy objective-only start event.

## Inspected real integration

Inspected the MacBook install under
`~/.pi/agent/git/github.com/matifuentes2/pi-codex-goal/src/`
at commit `49caf02f33bcccb42d51655c128f0cd0cb5ece61`:

- `goal-runtime-controller.ts::registerGoalRuntimeController` listens to
  `pi-codex-goal:start`, extracts **only `objective`**, and uses `replaceGoal` /
  `controller.setGoal`. Extra metadata sent on that event is silently ignored.
  It also unconditionally replaces an existing goal.
- `tools.ts::update_goal` calls `host.completeGoal`.
- `goal-runtime-controller.ts::completeGoal` accounts usage and delegates to
  `goal-state-controller.ts::completeGoal`.
- The latter calls `updateGoalStatus(goal, "complete")` and persists a `set`
  transition. There is no awaited completion validator.
- `types.ts::ThreadGoal` has no policy/evidence field. Custom goal entries are
  version 1 and contain snapshots, usage and clear/recovery state only.
- `commands.ts` currently offers pause/resume/clear/copy, not manual completion.
  Any future manual/API completion must still go through the invariant below.

The Pi SDK's `tool_call` interception is not a substitute: it gates a tool
invocation, not all persistence transitions. Prompt additions, post-hoc state
correction, or treating CI success as reviewer success do not solve this.

## Required companion implementation scope (blocking)

1. Add a **durable policy descriptor** to protected goals, including policy ID,
   version/configuration and goal ID. Keep legacy generic goals unchanged.
   Preserve this descriptor through accounting, pause/resume, replacement,
   compaction, reload, session switch/fork/tree navigation and persistence.
2. Add a policy registry and an **awaited, deny-by-default completion boundary**.
   Every path that can write `status: complete` (tool, command, API, runtime or
   direct `set`) must use it. Reject missing policy handlers, exceptions,
   aborts, invalid results and stale snapshots. A manual completion request
   must not bypass it. Clear/replacement is cancellation, never completion.
3. Make protected completion asynchronous. Audit before changing completion
   state or running terminal transition effects; re-check goal ID/policy and
   execution generation after awaiting the audit. Concurrent completion calls,
   replacements and newer review attempts must invalidate old authorizations.
   A newer failed/running attempt supersedes any older clean one.
4. Capture **trusted actual reviewer execution**, including setup failure before
   child launch. Store unique attempt ID, goal ID, reviewed PR head, fresh-context
   provenance, terminal execution status/reason and raw final reviewer output.
   Do not accept parent-authored evidence, prompt claims, partial output or
   manually uploaded verdict files as proof. On interrupted in-flight attempts,
   persist failure/unknown rather than retaining an earlier clean authorization.
   On resume, require a new attempt when the persisted execution is not known
   successful. No unauthorized model/provider fallback.
5. Provide the adapter below and integration tests exercising the **real** state
   controller, tools and persistence, including manual/direct completion,
   reload/resume, stale attempts and races. Preserve generic goals' behavior.
6. Return/report audit category and reason; review failure is not a finding or
   CI success. Leave a rejected completion non-complete (pause with attention
   for execution/setup errors); do not let automatic continuation spin forever
   on an unsupported reviewer model.

This is a companion code change, not a settings/model-pin fix. No companion
checkout was changed by this PR. The parent owns nixos-config PR #110 separately.

## Proposed adapter contract

Types are defined in `src/goal-host.ts`. On synchronous Pi event
`pi-codex-goal:completion-policy-host:v1`, exactly one companion listener calls
`request.provide(host)` before returning. No reply, late replies, duplicate
providers, wrong version, registration error or missing functions block start.

The host exposes:

- `apiVersion: 1`
- `registerPolicy(id, audit)` — register/replace the runtime validator. Restored
  goals with an unavailable validator must remain non-completable. The extension
  re-registers on session start and before a guarded start.
- `startGoal({objective, policy: {id, config}})` — atomically bind and persist the
  policy **before** exposing/queuing the goal. Return `{ok: true, goalId}` only
  after protection is installed. Reject an existing non-complete goal without
  explicit replacement authorization. On failure, leave existing state intact.

This version certifies **all** the invariant requirements above, not just the
presence of these functions. Do not expose this version from a partial shim that
forwards to `pi-codex-goal:start`. Do not persist callbacks; persist the descriptor
and resolve the registered validator after restore. Do not pass evidence supplied
as tool parameters; build `CompletionEvidence` from the host's execution ledger.

The audit callback is already wired to `src/review-policy.ts::auditCompletion`.
It independently reads the current PR head/base, checks trusted execution and
explicit verdict, checks CI/mergeability separately, then re-reads metadata to
reject a head/base race. A subsequent remote push is inherently possible after
any local audit; record the exact authorized SHA at completion. GitHub branch
protection remains the authority for merging. This extension never merges.

## Verdict and audit semantics

A successfully completed fresh reviewer must return **only** JSON:

```json
{
  "schemaVersion": 1,
  "attemptId": "host-issued-attempt-id",
  "headSha": "0123456789abcdef0123456789abcdef01234567",
  "decision": "clean",
  "findings": []
}
```

`changes_requested` requires nonempty finding strings and blocks completion until
fixes are pushed and a new reviewer succeeds. Contradictory clean/nonempty output,
missing fields, extra fields, mismatched attempt/head, empty/missing/non-JSON
output, failed execution and non-fresh provenance all fail closed. The host must
provide the attempt ID and expected head to the reviewer and independently track
both. The review policy is intentionally not an LLM-callable "record success" tool.

Categories:

- `review-failed`: execution/setup/runtime/interruption, absent/malformed/stale
  verdict, or wrong goal/attempt/freshness.
- `findings-unresolved`: valid changes-requested verdict.
- `ci-blocked`: conflicts/unknown mergeability, missing/pending/non-passing checks,
  or checks command failure. No-checks and skipping are not silently green.
- `blocked`: unavailable host, metadata/transport errors, changed target/head,
  or invalid persisted configuration.
- `ready`: fresh successful execution, explicit clean current-head verdict,
  unchanged required base, mergeable PR and all reported checks passing.

The existing objective's additional duties (Codex thread inspection/direct replies,
validation, Spanish comments, etc.) remain instructions, not programmatic checks
implemented by this policy. This change does not claim otherwise.

## Validation and limits

Run `npm test` with Node supporting TypeScript stripping (Node 22.18+ or 24).
Tests use Node's built-in test runner; no dependency or lockfile upgrades.
They cover failed launch/runtime/interruption, missing/malformed verdict, stale
head/attempt, clean review, unresolved findings, CI independence, audit races,
unsupported/malformed companion, startup errors, and no generic goal overrides.

Adapter tests use a **mock proposed host**. They do not demonstrate enforcement
inside the installed companion or prove its lifecycle behavior. Until the real
companion work above ships and passes integration tests, the workflow is blocked
and this work must not be described as full completion of the requested gate.
