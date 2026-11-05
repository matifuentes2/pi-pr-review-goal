import assert from "node:assert/strict";
import test from "node:test";
import extension, { parseArgs } from "../extensions/pr-review-goal.ts";
import { getGuardedHost, HOST_EVENT } from "../src/goal-host.ts";
import { POLICY_ID } from "../src/review-policy.ts";

// This is an adapter contract test, NOT a real companion integration test.
function harness(host?: any) {
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const events: string[] = [];
  const notices: string[] = [];
  const starts: any[] = [];
  const policies = new Map<string, any>();
  const prepares = new Map<string, any>();
  const execs: any[] = [];
  const adapter = host ?? {
    apiVersion: 1,
    registerPolicy: (id: string, audit: any, prepare: any) => { policies.set(id, audit); prepares.set(id, prepare); },
    startGoal: async (request: any) => { starts.push(request); return { ok: true, goalId: "goal-1" }; },
  };
  let enabled = true;
  const pi: any = {
    on: (event: string, handler: any) => handlers.set(event, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    getCommands: () => [{ name: "goal", sourceInfo: { path: "/packages/pi-codex-goal/src/index.ts" } }],
    events: { emit: (name: string, request: any) => {
      events.push(name);
      if (enabled && name === HOST_EVENT) request.provide(adapter);
    } },
    exec: async (name: string, args: string[]) => {
      execs.push([name, args]);
      if (name === "git" && args[0] === "rev-parse") return { code: 0, stdout: "/repo\n" };
      if (name === "gh" && args[0] === "pr") return { code: 0, stdout: JSON.stringify({ baseRefName: "main", headRefOid: "a".repeat(40) }) };
      return { code: 0, stdout: "" };
    },
  };
  extension(pi);
  const run = (args = "7 --base main") => commands.get("pr-review-goal").handler(args, { cwd: "/repo", ui: { notify: (s: string) => notices.push(s) } });
  return { pi, run, commands, handlers, events, notices, starts, policies, prepares, execs, disable: () => { enabled = false; } };
}

test("legacy objective-only companion blocks before any repo mutation or goal replacement", async () => {
  const h = harness(); h.disable(); await h.run();
  assert.match(h.notices.join("\n"), /blocked:.*completion-policy host v1/);
  assert.equal(h.starts.length, 0); assert.equal(h.execs.length, 0);
  assert.ok(!h.events.includes("pi-codex-goal:start"));
});
test("generic goal tools/commands and lifecycle are not overridden", async () => {
  const h = harness(); h.disable(); h.handlers.get("session_start")(); await h.run();
  assert.deepEqual([...h.commands.keys()], ["pr-review-goal"]);
  assert.deepEqual([...h.handlers.keys()], ["session_start"]);
  assert.equal(h.starts.length, 0);
  // In particular, no global tool_call block, goal state writes, or registration
  // of create_goal/update_goal/pause/resume/clear is introduced.
});
test("a compatible adapter receives policy metadata, never objective-only dispatch", async () => {
  const h = harness(); await h.run();
  assert.equal(h.starts.length, 1);
  assert.deepEqual(h.starts[0].policy, { id: POLICY_ID, config: { repoRoot: "/repo", prNumber: 7, baseBranch: "main" } });
  assert.ok(h.starts[0].objective.length <= 8000);
  assert.ok(h.policies.has(POLICY_ID));
  assert.ok(!h.events.includes("pi-codex-goal:start"));
});
test("compatible host works from renamed installations without command path heuristics", async () => {
  const h = harness(); h.pi.getCommands = () => []; await h.run();
  assert.equal(h.starts.length, 1);
});
test("restored policy is re-registered on session_start", () => {
  const h = harness(); h.handlers.get("session_start")(); assert.ok(h.policies.has(POLICY_ID));
});
for (const adapter of [{}, { apiVersion: 2 }, { apiVersion: 1, startGoal() {} }, {
  apiVersion: 1, registerPolicy() { throw new Error("unsupported"); }, startGoal() {},
}]) {
  test("malformed/incompatible/throwing adapter cannot start a goal", async () => {
    const h = harness(adapter); await h.run(); assert.match(h.notices.join("\n"), /blocked:/); assert.equal(h.execs.length, 0);
  });
}
test("multiple companion replies fail closed", () => {
  assert.equal(getGuardedHost({ events: { emit: (_name: string, request: any) => { request.provide({}); request.provide({}); } } } as any), null);
});
test("late companion replies cannot enable goal start", async () => {
  let reply: any;
  const host = getGuardedHost({ events: { emit: (_name: string, request: any) => { reply = request.provide; } } } as any);
  reply({ apiVersion: 1, registerPolicy() {}, startGoal() {} }); assert.equal(host, null);
});
test("start failure reports blocked and never retries objective-only API", async () => {
  const h = harness({ apiVersion: 1, registerPolicy() {}, startGoal() { throw new Error("setup failure"); } });
  await h.run(); assert.match(h.notices.join("\n"), /blocked:.*setup failure/); assert.ok(!h.events.includes("pi-codex-goal:start"));
});
test("missing guarded-start acknowledgment reports blocked", async () => {
  const h = harness({ apiVersion: 1, registerPolicy() {}, async startGoal() { return { ok: true }; } });
  await h.run(); assert.match(h.notices.join("\n"), /blocked:.*missing goal ID/);
});
for (const mode of ["clean", "wrong-checkout", "dirty", "changed-head", "wrong-base", "truncated"] as const) {
  test(`trusted review preparation handles ${mode}`, async () => {
    const h = harness(); await h.run();
    let reads = 0;
    h.pi.exec = async (program: string, args: string[]) => {
      if (program === "gh" && args[1] === "view") return { code: 0, stdout: JSON.stringify({
        baseRefName: mode === "wrong-base" ? "other" : "main",
        headRefOid: mode === "changed-head" && reads++ > 0 ? "b".repeat(40) : "a".repeat(40),
      }) };
      if (program === "git" && args[0] === "rev-parse") return { code: 0, stdout: (mode === "wrong-checkout" ? "b" : "a").repeat(40) };
      if (program === "git" && args[0] === "status") return { code: 0, stdout: mode === "dirty" ? " M file.ts" : "" };
      return { code: 0, stdout: "trusted diff", truncated: mode === "truncated" };
    };
    const prepare = h.prepares.get(POLICY_ID);
    const pending = prepare({ repoRoot: "/repo", prNumber: 7, baseBranch: "main" }, "host-attempt");
    if (mode === "clean") {
      const input = await pending;
      assert.equal(input.headSha, "a".repeat(40));
      assert.match(input.prompt, /host-attempt/);
      assert.match(input.prompt, /trusted diff/);
    } else await assert.rejects(pending);
  });
}

test("argument contract preserved", () => {
  assert.deepEqual(parseArgs("7 --base main"), { prNumber: 7, baseBranch: "main" });
  assert.deepEqual(parseArgs("7"), { prNumber: 7, baseBranch: undefined });
  for (const args of ["", "0", "1 --base", "7 --base main --base dev", "7 --bad"]) assert.equal(parseArgs(args), null);
});
