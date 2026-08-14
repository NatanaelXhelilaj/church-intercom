// Checks that stopping a child actually waits for it to be gone.
//
// This is the guard on a real bug: playback's stop() used to send SIGTERM and
// return immediately, while `this.session` was already null. Tapping "Talk to
// the Building" off and straight back on then spawned a second ffmpeg while the
// first still held the sound card — ALSA hardware devices are exclusive, so the
// open failed and the stream came up silent. Intermittently, because it only
// happens when the restart lands inside the old process's shutdown window.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { terminateChild } from "../audio.js";

let failures = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${label}`);
    console.error(`       ${error.message}`);
  }
}

const alive = (child) => child.exitCode === null && child.signalCode === null;

console.log("terminateChild");

await check("waits for a cooperative process to exit", async () => {
  const child = spawn("sleep", ["30"]);
  await new Promise((r) => child.once("spawn", r));

  await terminateChild(child);

  // The contract is that the process is gone by the time this resolves, not
  // merely that a signal was delivered.
  assert.equal(alive(child), false, "process still alive after terminateChild resolved");
});

await check("returns immediately for an already-dead process", async () => {
  const child = spawn("true", []);
  await new Promise((r) => child.once("exit", r));

  const started = process.hrtime.bigint();
  await terminateChild(child);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(ms < 200, `took ${ms.toFixed(0)}ms; should be a no-op`);
});

await check("escalates to SIGKILL when SIGTERM is ignored", async () => {
  // Traps SIGTERM and keeps running, which is close enough to an ffmpeg wedged
  // on a blocking read to exercise the escalation path.
  //
  // It announces itself once the trap is installed, and the test waits for that
  // rather than for "spawn": until the shell has run the trap builtin the
  // default disposition still applies, and a SIGTERM sent in that window kills
  // it outright — which is a race in the test, not the behaviour under test.
  const child = spawn("sh", ["-c", 'trap "" TERM; echo ready; while true; do sleep 0.2; done']);
  await new Promise((resolve) => {
    child.stdout.once("data", resolve);
  });

  const started = process.hrtime.bigint();
  await terminateChild(child, 500);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(alive(child), false, "process survived terminateChild");
  assert.equal(child.signalCode, "SIGKILL", `expected SIGKILL, got ${child.signalCode}`);
  // Must not have waited for the outer give-up timer.
  assert.ok(ms < 2000, `took ${ms.toFixed(0)}ms; escalation was too slow`);
});

await check("tolerates a null child", async () => {
  await terminateChild(null);
  await terminateChild(undefined);
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
