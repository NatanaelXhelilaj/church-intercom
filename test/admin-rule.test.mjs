// Verifies the rule that decides who gets the admin surface. Admin rights gate
// kicking people out of a room, taking over the building's speakers and
// repointing the server's sound card, so the truth table is worth pinning down.
//
// Runs standalone: no server, no database.
import assert from "node:assert/strict";

import { resolveAdmin } from "../auth.js";

let failures = 0;

function check(label, actual, expected) {
  try {
    assert.equal(actual, expected);
    console.log(`  ok   ${label}`);
  } catch {
    failures += 1;
    console.error(`  FAIL ${label} — expected ${expected}, got ${actual}`);
  }
}

console.log("admin rule: both the database flag and an \"admin\" username");

// Granted: flag set and the username says admin.
check('"admin" with flag', resolveAdmin("admin", true), true);
check('"admin2" with flag', resolveAdmin("admin2", true), true);
check('"sound-admin" with flag', resolveAdmin("sound-admin", true), true);
check('"ADMIN" with flag (case-insensitive)', resolveAdmin("ADMIN", true), true);

// Denied: the flag alone is not enough any more.
check('"nati" with flag', resolveAdmin("nati", true), false);
check('"pastor" with flag', resolveAdmin("pastor", true), false);

// Denied: the username alone never grants anything. This is the direction that
// matters — the rule must not become a way to self-promote by picking a name.
check('"admin" without flag', resolveAdmin("admin", false), false);
check('"admin" with undefined flag', resolveAdmin("admin", undefined), false);

// Junk input must fail closed rather than throw.
check("null username", resolveAdmin(null, true), false);
check("undefined username", resolveAdmin(undefined, true), false);
check("empty username", resolveAdmin("", true), false);
check("no arguments", resolveAdmin(), false);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
