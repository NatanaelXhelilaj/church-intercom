// Verifies the rule that decides who gets the admin surface. Admin rights gate
// kicking people out of a room, taking over the building's speakers and
// repointing the server's sound card, so the truth table is worth pinning down.
//
// Two inputs: the account's is_admin column (the capability) and the "Sign in
// as administrator" checkbox (the intent). Both are required.
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

console.log('admin rule: the database flag AND the "as administrator" checkbox');

// Granted: an admin account that asked for an admin session.
check("flagged account, box ticked", resolveAdmin(true, true), true);

// Denied: the checkbox alone never grants anything. This is the direction that
// matters — ticking a box must not be a way to self-promote.
check("unflagged account, box ticked", resolveAdmin(false, true), false);
check("undefined account flag, box ticked", resolveAdmin(undefined, true), false);

// Denied: an admin who did not ask spends the session as an ordinary user,
// which is the point of having the choice at all.
check("flagged account, box unticked", resolveAdmin(true, false), false);
check("flagged account, intent undefined", resolveAdmin(true, undefined), false);

// Neither.
check("unflagged account, box unticked", resolveAdmin(false, false), false);

// Junk input must fail closed rather than throw.
check("null inputs", resolveAdmin(null, null), false);
check("empty strings", resolveAdmin("", ""), false);
check("no arguments", resolveAdmin(), false);

// The username is no longer part of the rule at all: an account named "admin"
// gets nothing without the flag, and one named anything else is not penalised.
check('name "admin" is irrelevant without the flag', resolveAdmin(false, true), false);
check('name "nati" is no obstacle with the flag', resolveAdmin(true, true), true);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
