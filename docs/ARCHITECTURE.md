# Architecture

```text
             ┌───────────────────────── GPU machine ─────────────────────────┐
pharo-agent ─┼─► gateway (Node, :8000) ──────────► vLLM (:8000 internal) ──► GPU(s)
  /v1/...    │     ├─ identity: client ID per machine   ▲ /metrics
             │     ├─ limits: 5 h session, week,        │
             │     │  per minute, at once, per request  │ GGUF (one file)
             │     ├─ metering → SQLite (WAL)           │
             │     ├─ engine pool: health, routing,     fetch-models ◄── Hugging Face
             │     │  failover, metrics                 (download, merge shards)
             │     ├─ machine monitor: GPU (nvidia-smi),
             │     │  CPU, memory, disk → incidents
             │     └─ admin API + dashboard (/admin)
             └────────────────────────────────────────────────────────────────┘
```

## Source

| File | Job |
|---|---|
| `src/server.ts` | Process entry: config, crash and incident recording, graceful shutdown |
| `src/app.ts` | HTTP routes: public API, chat proxy (streaming), admin API, dashboard files |
| `src/limits.ts` | Claude-style limits: rolling 5-hour session, rolling week, per minute, concurrency, per request |
| `src/db.ts` | SQLite: clients, every request (tokens, latency, first token, status, engine), registrations, incidents |
| `src/engines.ts` | Engine pool: health checks, least-busy routing, failover, vLLM / llama.cpp Prometheus metrics |
| `src/machine.ts` | Host readings (GPU via nvidia-smi, CPU, available memory, disk) and the incidents they raise |
| `src/models.ts`, `src/fetch-models.ts` | Download GGUF from Hugging Face (resumable, `HF_TOKEN`), merge split files with `llama-gguf-split` |
| `src/log.ts` | JSON-lines log (stdout + a rotated file the dashboard tails) |
| `dashboard/` | Admin dashboard: plain HTML / CSS / JS, no build step |
| `config/plans.json` | Limits per plan |
| `config/models.json` | Models: Hugging Face repo, GGUF file(s), tokenizer |
| `deploy/` | Dockerfile and Compose (fetcher, vLLM or llama.cpp, gateway) |

## Identity Without Login

pharo-agent sends `SHA-256(machine id)` to `POST /v1/register`. The machine id
is IOPlatformUUID on macOS, `/etc/machine-id` on Linux, and MachineGuid on
Windows. The raw id never leaves the machine. The gateway answers with a client
ID, and the same fingerprint always gets the same client ID back, so
reinstalling pharo-agent doesn't reset its limits. pharo-agent sends the ID on
every request (`X-Pharo-Client-Id`).

This is not authentication: someone determined can fake fingerprints. Two
safeguards keep that expensive:
- new client IDs per IP address are capped per day;
- a weekly token cap applies per IP address (`perIpMultiplier` × the default plan).

When real accounts are needed, the client ID is where they attach.

## Limits

They work like Claude's plans:
- **Session:** the first request starts a window of `sessionHours` (5). Its tokens
  (prompt + completion) count against `tokensPerSession`, and the window ends
  5 hours after it started.
- **Week:** the tokens of the last 7 days count against `tokensPerWeek`.
- **Per minute and at once:** `requestsPerMinute`, `maxConcurrent`.
- **Per request:** `max_tokens` is clamped to `maxTokensPerRequest` and to what
  the session and week have left, so a request cannot overshoot much.

A request over a limit gets `429` with `retry-after`, `resets_at`, and a
sentence pharo-agent shows as is. Every response carries
`x-ratelimit-remaining-session-tokens` and `x-ratelimit-remaining-weekly-tokens`.

## Metering

Tokens come from the engine's own `usage` (for streaming, the gateway asks vLLM
for `include_usage`). If an engine reports none, the gateway estimates them
rather than leaving them uncounted. Each request is one row: client, IP, model,
prompt and completion tokens, latency, time to first token, status, error, and
which engine served it.

## Engines And Parallelism

vLLM batches requests continuously, so one GPU serves many machines at once
(`--max-num-seqs`). `--tensor-parallel-size` splits a model over several GPUs.
More vLLM replicas (or machines) are just more entries in
`PHARO_CLOUD_UPSTREAMS`. The gateway sends each request to the healthy engine
with the fewest requests in flight plus waiting, and moves to another engine if
the connection fails before any output.

## Incidents

Problems become incidents in the dashboard: opened once, counted while they
repeat, and closed when things are normal again:
- an engine down;
- 10 or more failed requests in 5 minutes;
- disk under 10% free (critical under 5%);
- available memory under 5%;
- GPU memory full, or a GPU at 87 °C or hotter;
- the gateway at capacity, or many registrations from one IP;
- gateway errors and crashes (recorded just before the restart).
