# Sandbox First-Command Boot Penalty

Minimal reproduction showing that the first `runCommand` after `Sandbox.create()` takes **seconds** even for trivial commands, while subsequent commands take **milliseconds**.

## The Issue

```typescript
const sandbox = await Sandbox.create({
  source: { type: "snapshot", snapshotId },
  ports: [3000],
  timeout: 60_000,
  resources: { vcpus: 1 },
});
// ✅ create() resolves in ~1.5s, status is "running"

const t1 = Date.now();
await sandbox.runCommand("echo", ["hello"]);
console.log(Date.now() - t1);
// ❌ 6,480ms — just to echo "hello"
//    The VM is still booting. The command waits server-side.

const t2 = Date.now();
await sandbox.runCommand("echo", ["hello"]);
console.log(Date.now() - t2);
// ✅ 207ms — VM is ready now. This is the expected speed.
```

## The First-Command Penalty

`Sandbox.create()` resolves before the VM is fully ready. The first `runCommand` absorbs the remaining boot time. Every subsequent command is fast.

**Benchmark (snapshot restores, local machine):**

```typescript
// Each cycle creates a NEW sandbox from the same snapshot

// Cycle 1 — cold infrastructure
await Sandbox.create(...)          // 2,057ms — fast return
await sandbox.runCommand("echo")   // 32,919ms ← 😱 33 seconds for echo
await sandbox.runCommand("echo")   // 293ms    ← normal

// Cycle 2 — warm infrastructure (ran seconds after cycle 1)
await Sandbox.create(...)          // 1,500ms
await sandbox.runCommand("echo")   // 1,553ms  ← still 7.5x slower than 2nd
await sandbox.runCommand("echo")   // 207ms    ← normal

// Cycle 3
await Sandbox.create(...)          // 1,506ms
await sandbox.runCommand("echo")   // 2,161ms  ← still 9.6x slower than 2nd
await sandbox.runCommand("echo")   // 226ms    ← normal
```

**Production (Vercel function, restores separated by minutes):**

```typescript
// Every restore pays the full penalty — no warm infrastructure benefit

await Sandbox.create(...)          // 1,200ms
await sandbox.runCommand("bash", [script])
// Wall clock:     11,880ms
// In-sandbox time: 5,689ms  (measured by the script itself)
// VM boot penalty: 6,191ms  ← dead time before script starts executing
```

The production penalty is **~6 seconds on every restore**, consistently.

## Our Use Case

We run [OpenClaw](https://openclaw.ai) in a Vercel Sandbox. The sandbox sleeps after inactivity. When a user sends a message, we restore from snapshot:

```typescript
// What our restore looks like today:
const sandbox = await Sandbox.create({ source: { type: "snapshot", snapshotId } });
//                                      1.5s ✅

await sandbox.runCommand("bash", [startupScript]);
//   Total wall clock: 12s
//   Actual script work: 6s (gateway booting)
//   VM boot penalty:    6s (waiting for VM to accept commands)
//                       ^^^ This is the problem

// If create() waited for VM readiness:
//   Total wall clock: ~6s (just the actual gateway boot)
//   Saved: 6 seconds per restore
```

## Setup

```bash
npm install
vercel link
vercel env pull
```

## Run Locally

```bash
node bench.mjs
```

## Run from a Vercel Function

Deploy the API route and hit it — this proves the penalty is worse from inside a Vercel function:

```bash
vercel deploy --prod
curl https://YOUR_DEPLOYMENT.vercel.app/api/bench
```

The `/api/bench` endpoint runs the exact same benchmark from a Vercel function (iad1 region, same as sandboxes) and returns JSON with all timings.

Compare the output to `node bench.mjs` — the first-command penalty is significantly larger from a Vercel function than from a local machine.

## SDK Source Context

Looking at the SDK source (`@vercel/sandbox` v1.8.1):

```javascript
// sandbox.js — create() is a single API call, no readiness polling
static async create(params) {
  const client = new APIClient({ ... });
  const sandbox = await client.createSandbox({ ... });
  //              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  //              Single POST to /v1/sandboxes
  //              Returns as soon as API responds
  //              Does NOT poll for VM readiness
  return new DisposableSandbox({ client, sandbox, routes });
}
```

```javascript
// api-client.js — runCommand holds the connection open until exit
async runCommand(params) {
  const response = await this.request(`/v1/sandboxes/${id}/cmd`, {
    method: "POST",
    body: JSON.stringify({ command, args, wait: true }),
  });
  // Response is NDJSON stream:
  //   chunk 1: command started (after VM is ready)
  //            ^^^ THIS IS WHERE THE WAIT HAPPENS
  //   chunk 2: command finished
}
```

The server queues the command and waits for the VM to be ready before executing. That wait is invisible to the caller — it just looks like a slow `runCommand`.

## Docs vs Measured Reality

The current docs make three performance claims that conflict with our measurements:

| Docs claim | Source | Measured |
|-----------|--------|---------|
| "Startup time: Milliseconds" | [Concepts: Sandboxes vs containers](https://vercel.com/docs/vercel-sandbox/concepts) | First command after create: **1.5-33 seconds** |
| "Warm start: 0.41s" | [KB: Snapshots for faster startup](https://vercel.com/kb/guide/how-to-use-snapshots-for-faster-sandbox-startup) | `create()` is 0.41s, but first `runCommand` adds **1.5-33s** on top |
| "Resuming from a snapshot is even faster" | [Concepts: How sandboxes work](https://vercel.com/docs/vercel-sandbox/concepts) | Snapshot restore first-command penalty (**7-112x**) is worse than fresh create (**3.1x**) |

The "warm start: 0.41s" measures only `Sandbox.create()` — it does not include the first `runCommand`, which is where users actually interact with the sandbox. A developer reading "0.41s warm start" would expect to run commands in under a second.

## Environment

- `@vercel/sandbox`: 1.8.1
- vCPU: 1
- All sandboxes in `iad1`
