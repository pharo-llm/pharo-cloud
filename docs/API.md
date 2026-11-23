# API

OpenAI-compatible, so any OpenAI client works once it sends `X-Pharo-Client-Id`.

## Public

### `GET /v1/status`

No ID needed.

```json
{ "ok": true, "service": "pharo-cloud", "version": "0.1.0", "models": ["pharo-coder"], "defaultModel": "pharo-coder",
  "engines": { "healthy": 1, "total": 1 }, "queue": { "running": 3, "waiting": 0 } }
```

### `POST /v1/register`

```json
{ "fingerprint": "<sha256 hex of the machine id>", "os": "darwin", "clientVersion": "0.1.0" }
```

Answers `201` for a new machine, or `200` with `"existing": true`:

```json
{ "clientId": "pcl_…", "plan": "standard", "defaultModel": "pharo-coder", "usage": { … } }
```

`429 registration_limit` means too many new machines from one IP today.

### `GET /v1/models`

The models served right now.

### `POST /v1/chat/completions`

Send the header `X-Pharo-Client-Id: pcl_…`. The body is the usual OpenAI
chat body, with `stream` supported. `model` may be omitted or `"default"`.
`max_tokens` is clamped to the plan and to what's left.

Response headers:

```text
x-pharo-cloud-plan: standard
x-ratelimit-limit-session-tokens: 300000
x-ratelimit-remaining-session-tokens: 287410
x-ratelimit-reset-session: 2026-11-23T21:44:16.073Z
x-ratelimit-limit-weekly-tokens: 3000000
x-ratelimit-remaining-weekly-tokens: 2950122
```

Errors (OpenAI shape):

| Status | `error.type` | Meaning |
|---|---|---|
| 401 | `unregistered` | Missing or unknown client ID: register first |
| 403 | `blocked` | Blocked by the admin |
| 429 | `session_limit` / `weekly_limit` | Token limit. Has `resets_at` and `retry-after` |
| 429 | `rate_limit` / `concurrency_limit` / `ip_limit` | Too many requests per minute, at once, or from this IP |
| 503 | `unavailable` / `overloaded` | No engine ready, or at capacity. Retry after `retry-after` |

```json
{ "error": { "type": "session_limit", "code": "session_limit",
  "message": "You reached your 5-hour usage limit (300,000 tokens). It resets in 2h 10m.",
  "resets_at": "2026-11-23T21:44:16.073Z" } }
```

### `GET /v1/usage`

Send `X-Pharo-Client-Id`.

```json
{ "clientId": "pcl_…", "plan": "standard", "planLabel": "Standard", "status": "active",
  "session": { "used": 12590, "limit": 300000, "resetsAt": "…", "hours": 5, "active": true },
  "week": { "used": 49878, "limit": 3000000, "resetsAt": "…" },
  "minute": { "used": 2, "limit": 30 }, "concurrent": { "used": 0, "limit": 2 },
  "maxTokensPerRequest": 4096, "last7Days": [{ "day": "2026-11-23", "tokens": 49878, "requests": 112 }] }
```

## Admin

Allowed from loopback (the machine itself, or an SSH tunnel), or with
`Authorization: Bearer $PHARO_CLOUD_ADMIN_TOKEN`.

| Route | |
|---|---|
| `GET /admin/api/overview` | Totals (hour / day / week / all time), latency, machines, engines + metrics, machine readings, models, plans |
| `GET /admin/api/series?range=1h\|24h\|7d\|30d[&client=id]` | Tokens, requests and errors per bucket |
| `GET /admin/api/clients` | Every machine, with its usage |
| `GET /admin/api/clients/:id` | One machine: usage, last 100 requests, 7-day series |
| `PATCH /admin/api/clients/:id` | `{ "plan": "extended", "status": "blocked" \| "active", "note": "…", "resetUsage": true }` |
| `GET /admin/api/incidents` · `POST /admin/api/incidents/:id/resolve` | Issues |
| `GET /admin/api/errors` | Recent failed requests |
| `GET /admin/api/logs?lines=300` | Gateway log |
| `GET /admin/api/models` | Download status of each model |
| `POST /admin/api/engines/check` | Health-check engines now |
| `POST /admin/api/plans/reload` | Re-read `config/plans.json` without restarting |
