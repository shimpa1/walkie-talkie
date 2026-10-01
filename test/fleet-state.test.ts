import { test } from "node:test";
import assert from "node:assert/strict";

import { createFleetStateProvider, parseFleetState } from "../src/fleet-state.js";
import type { FirstmateClient, RunResult } from "../src/firstmate.js";

interface RecordedCall {
  script: string;
  args: readonly string[];
}

function stubClient(
  handler: (call: RecordedCall) => RunResult,
): FirstmateClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async run(script: string, args: readonly string[]): Promise<RunResult> {
      const call = { script, args };
      calls.push(call);
      return handler(call);
    },
  };
}

test("parseFleetState reduces the bearings projection to the fields a state needs", () => {
  const state = parseFleetState({
    in_flight: [{ id: "reach-slice", name: "Reach the slice", state: "working" }],
    secondmates: [{ id: "infra", state: "captain_decision" }],
    decisions_open: [{ id: "d1" }],
    gates: [{ id: "g1" }, { id: "g2" }],
  });
  assert.deepEqual(state, {
    in_flight: [{ id: "reach-slice", name: "Reach the slice", state: "working" }],
    secondmates: [{ id: "infra", state: "captain_decision" }],
    decisions_open: 1,
    gates: 2,
  });
});

test("parseFleetState treats missing surfaces as empty and rejects a non-object", () => {
  assert.deepEqual(parseFleetState({}), { in_flight: [], secondmates: [], decisions_open: 0, gates: 0 });
  assert.equal(parseFleetState("not a bearings object"), null);
  assert.equal(parseFleetState(null), null);
});

test("the provider caches a successful read within its TTL", async () => {
  let clock = 1000;
  const client = stubClient(() => ({
    stdout: JSON.stringify({ in_flight: [{ id: "t", state: "working" }], decisions_open: [], gates: [] }),
    stderr: "",
    code: 0,
  }));
  const provider = createFleetStateProvider(client, { ttlMs: 500, now: () => clock });

  await provider();
  await provider();
  assert.equal(client.calls.length, 1);

  clock += 500;
  await provider();
  assert.equal(client.calls.length, 2);
});

test("the provider returns null on a failed read and does not cache it", async () => {
  const client = stubClient(() => ({ stdout: "", stderr: "boom", code: 1 }));
  const provider = createFleetStateProvider(client, { ttlMs: 60_000 });
  assert.equal(await provider(), null);
  assert.equal(await provider(), null);
  assert.equal(client.calls.length, 2);
});

test("concurrent callers share one in-flight read", async () => {
  const calls: RecordedCall[] = [];
  let resolveRun: (value: RunResult) => void = () => {};
  const client: FirstmateClient = {
    run(script, args) {
      calls.push({ script, args });
      return new Promise<RunResult>((resolve) => {
        resolveRun = resolve;
      });
    },
  };
  const provider = createFleetStateProvider(client, { ttlMs: 60_000 });
  const first = provider();
  const second = provider();
  await Promise.resolve();
  assert.equal(calls.length, 1);

  resolveRun({
    stdout: JSON.stringify({ in_flight: [], decisions_open: [], gates: [] }),
    stderr: "",
    code: 0,
  });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
});
