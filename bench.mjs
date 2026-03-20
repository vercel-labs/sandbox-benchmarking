#!/usr/bin/env node

/**
 * Sandbox First-Command Boot Penalty Benchmark
 *
 * Demonstrates that the first runCommand after Sandbox.create() takes
 * ~6.5s from a Vercel function but ~175ms from a local machine.
 * Subsequent commands are ~60-200ms in both cases.
 *
 * Usage:
 *   vercel link   # link to a Vercel project
 *   vercel env pull
 *   node bench.mjs
 */

import { readFileSync } from "node:fs";
import { Sandbox } from "@vercel/sandbox";

// Load .env.local for OIDC credentials
try {
  const content = readFileSync(".env.local", "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq);
    let v = t.slice(eq + 1);
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
} catch {
  console.error("No .env.local found. Run: vercel link && vercel env pull");
  process.exit(1);
}

async function benchmarkFreshCreate() {
  console.log("=== Fresh Create (no snapshot) ===\n");

  const t0 = Date.now();
  const sandbox = await Sandbox.create({
    ports: [3000],
    timeout: 60_000,
    resources: { vcpus: 1 },
  });
  const createMs = Date.now() - t0;
  console.log(`Sandbox.create():  ${createMs}ms  (status: ${sandbox.status})`);

  // First command
  const t1 = Date.now();
  await sandbox.runCommand("echo", ["hello"]);
  const cmd1Ms = Date.now() - t1;
  console.log(`1st runCommand:    ${cmd1Ms}ms  (echo hello)`);

  // Second command
  const t2 = Date.now();
  await sandbox.runCommand("echo", ["hello"]);
  const cmd2Ms = Date.now() - t2;
  console.log(`2nd runCommand:    ${cmd2Ms}ms  (echo hello)`);

  // Third command
  const t3 = Date.now();
  await sandbox.runCommand("sh", ["-c", "exit 0"]);
  const cmd3Ms = Date.now() - t3;
  console.log(`3rd runCommand:    ${cmd3Ms}ms  (exit 0)`);

  console.log(`\nPenalty ratio:     ${(cmd1Ms / cmd2Ms).toFixed(1)}x  (1st / 2nd)`);
  console.log(`Total:             ${Date.now() - t0}ms\n`);

  // Snapshot for restore test
  console.log("Snapshotting...");
  const snap = await sandbox.snapshot();
  console.log(`Snapshot:          ${snap.snapshotId}\n`);
  return snap.snapshotId;
}

async function benchmarkSnapshotRestore(snapshotId) {
  console.log("=== Snapshot Restore ===\n");

  const t0 = Date.now();
  const sandbox = await Sandbox.create({
    source: { type: "snapshot", snapshotId },
    ports: [3000],
    timeout: 60_000,
    resources: { vcpus: 1 },
  });
  const createMs = Date.now() - t0;
  console.log(`Sandbox.create():  ${createMs}ms  (from snapshot, status: ${sandbox.status})`);

  // First command
  const t1 = Date.now();
  await sandbox.runCommand("echo", ["hello"]);
  const cmd1Ms = Date.now() - t1;
  console.log(`1st runCommand:    ${cmd1Ms}ms  (echo hello)`);

  // Second command
  const t2 = Date.now();
  await sandbox.runCommand("echo", ["hello"]);
  const cmd2Ms = Date.now() - t2;
  console.log(`2nd runCommand:    ${cmd2Ms}ms  (echo hello)`);

  // Third command
  const t3 = Date.now();
  await sandbox.runCommand("sh", ["-c", "exit 0"]);
  const cmd3Ms = Date.now() - t3;
  console.log(`3rd runCommand:    ${cmd3Ms}ms  (exit 0)`);

  console.log(`\nPenalty ratio:     ${(cmd1Ms / cmd2Ms).toFixed(1)}x  (1st / 2nd)`);
  console.log(`Total:             ${Date.now() - t0}ms\n`);

  await sandbox.snapshot();
  return { createMs, cmd1Ms, cmd2Ms, cmd3Ms };
}

async function main() {
  console.log("Sandbox First-Command Boot Penalty Benchmark");
  console.log("=============================================\n");

  // Test 1: Fresh create
  const snapshotId = await benchmarkFreshCreate();

  // Test 2: Snapshot restore (3 cycles)
  const results = [];
  for (let i = 0; i < 3; i++) {
    console.log(`--- Restore cycle ${i + 1}/3 ---\n`);
    const r = await benchmarkSnapshotRestore(snapshotId);
    results.push(r);
  }

  // Summary
  console.log("=== SUMMARY ===\n");
  console.log("Snapshot restore (3 cycles):");
  console.log("  Sandbox.create:  " + results.map(r => r.createMs + "ms").join(", "));
  console.log("  1st runCommand:  " + results.map(r => r.cmd1Ms + "ms").join(", "));
  console.log("  2nd runCommand:  " + results.map(r => r.cmd2Ms + "ms").join(", "));
  console.log("  3rd runCommand:  " + results.map(r => r.cmd3Ms + "ms").join(", "));

  const avg1st = Math.round(results.reduce((s, r) => s + r.cmd1Ms, 0) / results.length);
  const avg2nd = Math.round(results.reduce((s, r) => s + r.cmd2Ms, 0) / results.length);
  console.log(`\n  Avg 1st cmd:     ${avg1st}ms`);
  console.log(`  Avg 2nd cmd:     ${avg2nd}ms`);
  console.log(`  Avg penalty:     ${(avg1st / avg2nd).toFixed(1)}x`);
  console.log(`\nExpected: 1st ~175ms, 2nd ~175ms from local`);
  console.log(`          1st ~6500ms, 2nd ~60ms from Vercel function`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
