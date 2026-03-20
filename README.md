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

## Snapshot Restore Has a Consistent Boot Penalty

The penalty is present on **every** snapshot restore:

| Source | Create time | 1st cmd | 2nd cmd | Penalty |
|--------|------------|---------|---------|---------|
| Fresh create | 271s | 889ms | 287ms | 3.1x |
| **1st snapshot restore** | **2.1s** | **32,919ms** | **293ms** | **112x** |
| 2nd snapshot restore | 1.5s | 1,553ms | 207ms | 7.5x |
| 3rd snapshot restore | 1.5s | 2,161ms | 226ms | 9.6x |

**Note:** Cycles 2-3 appear faster because they ran seconds apart, benefiting from
warm infrastructure. In production (restores separated by minutes/hours), every
restore shows a consistent **~6 second** first-command penalty:

```
Production restore metrics (each separated by real stop/restore cycles):
  Restore 1: runCommand=11,880ms, gateway boot=5,689ms → 6.2s overhead
  Restore 2: runCommand=11,691ms, gateway boot=6,089ms → 5.6s overhead
  Restore 3: runCommand=11,969ms, gateway boot=6,014ms → 6.0s overhead
```

Fresh create takes longer to return (271s) but the VM is mostly ready when it does.
Snapshot restore returns fast (2s) but the VM isn't ready — the first command pays the full boot cost.

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
