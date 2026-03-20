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
vercel link        # link to any Vercel project with Sandbox access
vercel env pull    # downloads OIDC credentials to .env.local
```

## Run

```bash
node bench.mjs
```

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

## Environment

- `@vercel/sandbox`: 1.8.1
- vCPU: 1
- All sandboxes in `iad1`
