import { Sandbox } from "@vercel/sandbox";

export default async function handler(req, res) {
  const results = { fresh: null, restores: [], env: {} };

  results.env.region = process.env.VERCEL_REGION || process.env.AWS_REGION || "unknown";
  results.env.vercel = Boolean(process.env.VERCEL);

  try {
    // Step 1: Fresh create + measure commands
    const t0 = Date.now();
    const sandbox = await Sandbox.create({
      timeout: 60_000,
      resources: { vcpus: 1 },
    });
    const createMs = Date.now() - t0;

    const t1 = Date.now();
    await sandbox.runCommand("echo", ["hello"]);
    const cmd1Ms = Date.now() - t1;

    const t2 = Date.now();
    await sandbox.runCommand("echo", ["hello"]);
    const cmd2Ms = Date.now() - t2;

    const t3 = Date.now();
    await sandbox.runCommand("sh", ["-c", "exit 0"]);
    const cmd3Ms = Date.now() - t3;

    results.fresh = { createMs, cmd1Ms, cmd2Ms, cmd3Ms, penalty: +(cmd1Ms / cmd2Ms).toFixed(1) };

    // Step 2: Snapshot
    const snap = await sandbox.snapshot();
    const snapshotId = snap.snapshotId;
    const snapshotSize = snap.sizeBytes;
    results.snapshotId = snapshotId;
    results.snapshotSizeMB = Math.round(snapshotSize / 1024 / 1024);

    // Step 3: Restore 3 times
    for (let i = 0; i < 3; i++) {
      const rt0 = Date.now();
      const restored = await Sandbox.create({
        source: { type: "snapshot", snapshotId },
        timeout: 60_000,
        resources: { vcpus: 1 },
      });
      const rCreateMs = Date.now() - rt0;

      const rt1 = Date.now();
      await restored.runCommand("echo", ["hello"]);
      const rCmd1Ms = Date.now() - rt1;

      const rt2 = Date.now();
      await restored.runCommand("echo", ["hello"]);
      const rCmd2Ms = Date.now() - rt2;

      const rt3 = Date.now();
      await restored.runCommand("sh", ["-c", "exit 0"]);
      const rCmd3Ms = Date.now() - rt3;

      results.restores.push({
        cycle: i + 1,
        createMs: rCreateMs,
        cmd1Ms: rCmd1Ms,
        cmd2Ms: rCmd2Ms,
        cmd3Ms: rCmd3Ms,
        penalty: +(rCmd1Ms / rCmd2Ms).toFixed(1),
      });

      await restored.snapshot();
    }

    // Summary
    const avg1st = Math.round(results.restores.reduce((s, r) => s + r.cmd1Ms, 0) / results.restores.length);
    const avg2nd = Math.round(results.restores.reduce((s, r) => s + r.cmd2Ms, 0) / results.restores.length);
    results.summary = {
      avg1stCmdMs: avg1st,
      avg2ndCmdMs: avg2nd,
      avgPenalty: +(avg1st / avg2nd).toFixed(1),
    };

    res.status(200).json(results);
  } catch (err) {
    results.error = err.message;
    res.status(500).json(results);
  }
}

export const config = {
  maxDuration: 300,
};
