import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type ClientRow = {
  id: string
  fingerprint: string
  plan: string
  status: 'active' | 'blocked'
  first_seen: number
  last_seen: number
  os: string | null
  client_version: string | null
  ip: string | null
  session_start: number | null
  usage_reset_at: number
  note: string | null
}

export type RequestRow = {
  client_id: string
  ip: string | null
  ts: number
  model: string | null
  prompt_tokens: number
  completion_tokens: number
  latency_ms: number | null
  ttft_ms: number | null
  status: number
  error: string | null
  stream: number
  upstream: string | null
}

export type Severity = 'info' | 'warning' | 'critical'

export type EventRow = {
  id: number
  kind: string
  severity: Severity
  message: string
  details: string | null
  count: number
  first_ts: number
  last_ts: number
  resolved_ts: number | null
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

export class Store {
  readonly db: DatabaseSync

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        plan TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        os TEXT, client_version TEXT, ip TEXT,
        session_start INTEGER,
        usage_reset_at INTEGER NOT NULL DEFAULT 0,
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL, ip TEXT, ts INTEGER NOT NULL, model TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER, ttft_ms INTEGER, status INTEGER NOT NULL, error TEXT,
        stream INTEGER NOT NULL DEFAULT 0, upstream TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_client_ts ON requests(client_id, ts);
      CREATE INDEX IF NOT EXISTS requests_ip_ts ON requests(ip, ts);
      CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
      CREATE TABLE IF NOT EXISTS registrations (ip TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS registrations_ip_ts ON registrations(ip, ts);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL, details TEXT,
        count INTEGER NOT NULL DEFAULT 1, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, resolved_ts INTEGER
      );
      CREATE INDEX IF NOT EXISTS events_open ON events(kind, resolved_ts);
    `)
  }

  close(): void {
    this.db.close()
  }

  // -- clients ---------------------------------------------------------------

  clientById(id: string): ClientRow | undefined {
    return this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as ClientRow | undefined
  }

  clientByFingerprint(fingerprint: string): ClientRow | undefined {
    return this.db.prepare('SELECT * FROM clients WHERE fingerprint = ?').get(fingerprint) as ClientRow | undefined
  }

  insertClient(row: Pick<ClientRow, 'id' | 'fingerprint' | 'plan' | 'os' | 'client_version' | 'ip'>, now: number): void {
    this.db.prepare('INSERT INTO clients (id, fingerprint, plan, status, first_seen, last_seen, os, client_version, ip) VALUES (?, ?, ?, \'active\', ?, ?, ?, ?, ?)')
      .run(row.id, row.fingerprint, row.plan, now, now, row.os, row.client_version, row.ip)
  }

  touchClient(id: string, now: number, ip: string | null, info: { os?: string; clientVersion?: string } = {}): void {
    this.db.prepare('UPDATE clients SET last_seen = ?, ip = COALESCE(?, ip), os = COALESCE(?, os), client_version = COALESCE(?, client_version) WHERE id = ?')
      .run(now, ip, info.os ?? null, info.clientVersion ?? null, id)
  }

  setSessionStart(id: string, start: number | null): void {
    this.db.prepare('UPDATE clients SET session_start = ? WHERE id = ?').run(start, id)
  }

  updateClient(id: string, changes: { plan?: string; status?: 'active' | 'blocked'; note?: string | null; resetUsage?: boolean }, now: number): boolean {
    const current = this.clientById(id)
    if (!current) return false
    this.db.prepare('UPDATE clients SET plan = ?, status = ?, note = ?, usage_reset_at = ?, session_start = ? WHERE id = ?').run(
      changes.plan ?? current.plan,
      changes.status ?? current.status,
      changes.note === undefined ? current.note : changes.note,
      changes.resetUsage ? now : current.usage_reset_at,
      changes.resetUsage ? null : current.session_start,
      id,
    )
    return true
  }

  listClients(now: number): (ClientRow & { tokens_24h: number; tokens_7d: number; requests_24h: number; errors_24h: number })[] {
    return this.db.prepare(`
      SELECT c.*,
        COALESCE((SELECT SUM(prompt_tokens + completion_tokens) FROM requests r WHERE r.client_id = c.id AND r.ts >= ?), 0) AS tokens_24h,
        COALESCE((SELECT SUM(prompt_tokens + completion_tokens) FROM requests r WHERE r.client_id = c.id AND r.ts >= ?), 0) AS tokens_7d,
        (SELECT COUNT(*) FROM requests r WHERE r.client_id = c.id AND r.ts >= ?) AS requests_24h,
        (SELECT COUNT(*) FROM requests r WHERE r.client_id = c.id AND r.ts >= ? AND r.status >= 500) AS errors_24h
      FROM clients c ORDER BY c.last_seen DESC
    `).all(now - DAY, now - 7 * DAY, now - DAY, now - DAY) as never
  }

  // -- registrations ---------------------------------------------------------

  recordRegistration(ip: string, now: number): void {
    this.db.prepare('INSERT INTO registrations (ip, ts) VALUES (?, ?)').run(ip, now)
  }

  registrationsSince(ip: string, since: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE ip = ? AND ts >= ?').get(ip, since) as { n: number }).n
  }

  // -- usage -----------------------------------------------------------------

  recordRequest(row: RequestRow): void {
    this.db.prepare(`INSERT INTO requests (client_id, ip, ts, model, prompt_tokens, completion_tokens, latency_ms, ttft_ms, status, error, stream, upstream)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.client_id, row.ip, row.ts, row.model, row.prompt_tokens, row.completion_tokens, row.latency_ms, row.ttft_ms, row.status, row.error, row.stream, row.upstream,
    )
  }

  /** Tokens used by a client since `since` (and since its last usage reset). */
  clientTokensSince(id: string, since: number): number {
    return (this.db.prepare(`SELECT COALESCE(SUM(r.prompt_tokens + r.completion_tokens), 0) AS n FROM requests r JOIN clients c ON c.id = r.client_id
      WHERE r.client_id = ? AND r.ts >= ? AND r.ts >= c.usage_reset_at`).get(id, since) as { n: number }).n
  }

  /** Oldest request in a window: when the rolling window starts freeing tokens. */
  clientOldestSince(id: string, since: number): number | undefined {
    const row = this.db.prepare(`SELECT MIN(r.ts) AS ts FROM requests r JOIN clients c ON c.id = r.client_id
      WHERE r.client_id = ? AND r.ts >= ? AND r.ts >= c.usage_reset_at AND (r.prompt_tokens + r.completion_tokens) > 0`).get(id, since) as { ts: number | null }
    return row.ts ?? undefined
  }

  ipTokensSince(ip: string, since: number): number {
    return (this.db.prepare('SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS n FROM requests WHERE ip = ? AND ts >= ?').get(ip, since) as { n: number }).n
  }

  clientRequests(id: string, limit = 50): RequestRow[] {
    return this.db.prepare('SELECT * FROM requests WHERE client_id = ? ORDER BY ts DESC LIMIT ?').all(id, limit) as RequestRow[]
  }

  /** Buckets of `size` ms between since and now: tokens, requests, errors. */
  series(since: number, size: number, clientId?: string): { t: number; tokens: number; requests: number; errors: number }[] {
    // node:sqlite binds JS numbers as REAL, so ts / size would not round down: use the integer modulo.
    const rows = this.db.prepare(`SELECT ts - (ts % ?) AS t, SUM(prompt_tokens + completion_tokens) AS tokens, COUNT(*) AS requests,
      SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS errors FROM requests WHERE ts >= ? ${clientId ? 'AND client_id = ?' : ''} GROUP BY t ORDER BY t`)
      .all(...(clientId ? [size, since, clientId] : [size, since])) as { t: number; tokens: number; requests: number; errors: number }[]
    const byT = new Map(rows.map(row => [Number(row.t), row]))
    const out: { t: number; tokens: number; requests: number; errors: number }[] = []
    for (let t = Math.floor(since / size) * size; t <= Date.now(); t += size) {
      const row = byT.get(t)
      out.push({ t, tokens: Number(row?.tokens ?? 0), requests: Number(row?.requests ?? 0), errors: Number(row?.errors ?? 0) })
    }
    return out
  }

  totals(since: number): { tokens: number; prompt: number; completion: number; requests: number; errors: number; limited: number; clients: number } {
    return this.db.prepare(`SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens, COALESCE(SUM(prompt_tokens), 0) AS prompt,
      COALESCE(SUM(completion_tokens), 0) AS completion, COUNT(*) AS requests,
      COALESCE(SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END), 0) AS errors,
      COALESCE(SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END), 0) AS limited,
      COUNT(DISTINCT client_id) AS clients FROM requests WHERE ts >= ?`).get(since) as never
  }

  latency(since: number): { p50: number | null; p95: number | null; ttftP50: number | null } {
    const values = (this.db.prepare('SELECT latency_ms AS v FROM requests WHERE ts >= ? AND status = 200 AND latency_ms IS NOT NULL ORDER BY latency_ms').all(since) as { v: number }[]).map(row => row.v)
    const ttft = (this.db.prepare('SELECT ttft_ms AS v FROM requests WHERE ts >= ? AND status = 200 AND ttft_ms IS NOT NULL ORDER BY ttft_ms').all(since) as { v: number }[]).map(row => row.v)
    const pick = (list: number[], q: number) => (list.length ? list[Math.min(list.length - 1, Math.floor(q * list.length))]! : null)
    return { p50: pick(values, 0.5), p95: pick(values, 0.95), ttftP50: pick(ttft, 0.5) }
  }

  recentErrors(limit = 50): RequestRow[] {
    return this.db.prepare('SELECT * FROM requests WHERE status >= 400 ORDER BY ts DESC LIMIT ?').all(limit) as RequestRow[]
  }

  modelBreakdown(since: number): { model: string; tokens: number; requests: number }[] {
    return this.db.prepare('SELECT COALESCE(model, \'?\') AS model, SUM(prompt_tokens + completion_tokens) AS tokens, COUNT(*) AS requests FROM requests WHERE ts >= ? GROUP BY model ORDER BY tokens DESC').all(since) as never
  }

  allTimeTokens(): number {
    return (this.db.prepare('SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS n FROM requests').get() as { n: number }).n
  }

  // -- incidents -------------------------------------------------------------

  /** Open (or bump) an incident of this kind. Repeats increase its count instead of flooding the list. */
  raise(kind: string, severity: Severity, message: string, details: unknown, now: number): void {
    const open = this.db.prepare('SELECT id FROM events WHERE kind = ? AND resolved_ts IS NULL').get(kind) as { id: number } | undefined
    const json = details === undefined ? null : JSON.stringify(details)
    if (open) this.db.prepare('UPDATE events SET count = count + 1, last_ts = ?, message = ?, severity = ?, details = ? WHERE id = ?').run(now, message, severity, json, open.id)
    else this.db.prepare('INSERT INTO events (kind, severity, message, details, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?)').run(kind, severity, message, json, now, now)
  }

  resolve(kind: string, now: number): void {
    this.db.prepare('UPDATE events SET resolved_ts = ? WHERE kind = ? AND resolved_ts IS NULL').run(now, kind)
  }

  events(limit = 100): EventRow[] {
    return this.db.prepare('SELECT * FROM events ORDER BY resolved_ts IS NOT NULL, last_ts DESC LIMIT ?').all(limit) as EventRow[]
  }

  /** Keep the database bounded: request rows older than `days`. */
  prune(now: number, days = 120): void {
    this.db.prepare('DELETE FROM requests WHERE ts < ?').run(now - days * DAY)
    this.db.prepare('DELETE FROM registrations WHERE ts < ?').run(now - 7 * DAY)
    this.db.prepare('DELETE FROM events WHERE resolved_ts IS NOT NULL AND resolved_ts < ?').run(now - 30 * DAY)
  }
}

export { DAY, HOUR }
