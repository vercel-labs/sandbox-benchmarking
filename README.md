# Sandbox First-Command Boot Penalty

Minimal reproduction showing that the first `runCommand` after `Sandbox.create()` has a **7-112x latency penalty** compared to subsequent commands on the same sandbox.

## The Issue

```
Sandbox.create():  1,500ms   (status: "running")
1st runCommand:    32,919ms  (echo hello)  ← 112x slower
2nd runCommand:    293ms     (echo hello)
3rd runCommand:    230ms     (exit 0)
```

`Sandbox.create()` resolves before the VM is fully ready. The first command absorbs the remaining boot time. Subsequent commands are fast (~200ms).

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

## Expected Output

```
=== Snapshot Restore ===

Sandbox.create():  1500ms  (from snapshot, status: running)
1st runCommand:    6480ms  (echo hello)     ← BOOT PENALTY
2nd runCommand:    207ms   (echo hello)
3rd runCommand:    184ms   (exit 0)

Penalty ratio:     31.3x  (1st / 2nd)
```

The penalty varies:
- **First restore after fresh snapshot**: 7-33 seconds (worst case)
- **Subsequent restores**: 1.5-6.5 seconds
- **2nd+ commands on same sandbox**: 60-300ms (expected)

## What the Benchmark Does

1. Creates a fresh sandbox (no snapshot)
2. Measures 3 sequential `runCommand` calls
3. Snapshots the sandbox
4. Restores from snapshot 3 times, measuring each `runCommand`
5. Reports the penalty ratio (1st command / 2nd command)

## SDK Source Context

`Sandbox.create()` does a single POST to `/v1/sandboxes` and returns when the API responds — it does **not** poll for VM readiness or wait for `status: "running"` to mean "VM is accepting commands."

`runCommand()` with the default `wait: true` holds the HTTP connection open (NDJSON streaming) until the command exits. The first command blocks server-side while the VM finishes booting.

## The First-Command Penalty

After `Sandbox.create()` resolves, the first `runCommand` consistently takes **seconds** — even for `echo hello`. The second command on the same sandbox takes **milliseconds**.

This happens on every snapshot restore. The VM isn't fully ready when `create()` returns. The first command absorbs the remaining boot time.

**Benchmark (local, back-to-back restores):**

| | Create | 1st cmd (`echo hello`) | 2nd cmd (`echo hello`) |
|---|--------|----------------------|----------------------|
| Restore 1 | 2.1s | **32.9s** | 293ms |
| Restore 2 | 1.5s | **1.6s** | 207ms |
| Restore 3 | 1.5s | **2.2s** | 226ms |

**Production (restores separated by minutes, from a Vercel function):**

| | Create | 1st cmd (startup script) | In-sandbox boot |
|---|--------|------------------------|-----------------|
| Restore 1 | 1.2s | **11.9s** | 5.7s |
| Restore 2 | 1.5s | **11.7s** | 6.1s |
| Restore 3 | 1.4s | **12.0s** | 6.0s |

In production, the first command takes ~12s but the actual work inside the sandbox (gateway boot) only takes ~6s. The other ~6s is the VM finishing its initialization before the command can start executing.

## Our Use Case

We run [OpenClaw](https://openclaw.ai) in a Vercel Sandbox for a chat application. The sandbox sleeps after 30 minutes of inactivity to save costs. When a user sends a message (via Slack, Telegram, Discord, or the web UI), we restore from snapshot and start the gateway.

**The first-command penalty is the dominant factor in user-perceived restore latency:**

```
User sends message
  → Sandbox.create (snapshot restore):  1.5s   ← fast
  → runCommand (start gateway):         6-33s  ← BOOT PENALTY
  → Gateway serves first response:      ~0.2s
  → Total wait:                         8-35s
```

Without the penalty, restore would be:
```
  → Sandbox.create:                     1.5s
  → runCommand (start gateway):         ~3.7s  (actual gateway boot)
  → Total wait:                         ~5.2s
```

The penalty adds 3-30 seconds of dead time where the command is queued server-side waiting for the VM to finish initializing.

## Environment

- `@vercel/sandbox`: 1.8.1
- vCPU: 1
- All sandboxes in `iad1`
