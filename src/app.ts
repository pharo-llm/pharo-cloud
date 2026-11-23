import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CloudConfig } from './config.ts'
import { ROOT, VERSION, defaultModel, loadConfig } from './config.ts'
import type { ClientRow } from './db.ts'
import { DAY, HOUR, Store } from './db.ts'
import { EnginePool } from './engines.ts'
import type { Engine } from './engines.ts'
import { HttpError, clientIp, isLoopback, readJson, safeEqual, sendError, sendJson } from './http.ts'
import { Limiter } from './limits.ts'
import type { Usage } from './limits.ts'
import { log, setLogFile, tailLog } from './log.ts'
import { checkMachine, snapshot } from './machine.ts'
import type { MachineSnapshot } from './machine.ts'
import { modelStatuses } from './models.ts'

export type App = {
  server: http.Server
  store: Store
  pool: EnginePool
  limiter: Limiter
  config: CloudConfig
  close(): Promise<void>
}

const startedAt = Date.now()

export function createApp(config: CloudConfig, options: { monitors?: boolean } = {}): App {
  setLogFile(config.logPath)
  const store = new Store(config.dbPath)
  const pool = new EnginePool(config, store)
  const limiter = new Limiter(store, config.plans)
  let machine: MachineSnapshot | undefined

  const monitor = async () => {
    try {
      machine = await snapshot([config.dbPath, config.modelsDir].map(file => path.dirname(file)).concat(config.modelsDir))
      checkMachine(store, machine)
      // Error bursts resolve themselves once requests succeed again.
      if (store.totals(Date.now() - 5 * 60_000).errors === 0) store.resolve('error_burst', Date.now())
    } catch (error) {
      log('warn', 'machine monitor failed', { error: (error as Error).message })
    }
  }
  const timers: NodeJS.Timeout[] = []
  if (options.monitors !== false) {
    pool.start()
    void monitor()
    timers.push(setInterval(() => void monitor(), 15_000))
    timers.push(setInterval(() => store.prune(Date.now()), 6 * HOUR))
    for (const timer of timers) timer.unref()
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      if (error instanceof HttpError) return sendError(res, error.status, error.type, error.message)
      log('error', 'unhandled request error', { url: req.url, error: (error as Error).stack })
      store.raise('gateway_error', 'warning', `Gateway error: ${(error as Error).message}`, { url: req.url }, Date.now())
      sendError(res, 500, 'internal_error', 'Pharo Cloud hit an internal error. It has been logged.')
    })
  })
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 70_000
  server.requestTimeout = 0 // long generations

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    const p = url.pathname
    if (p === '/healthz') return sendJson(res, 200, { ok: true })
    if (p === '/v1/status' && method === 'GET') return status(res)
    if (p === '/v1/register' && method === 'POST') return register(req, res)
    if (p === '/v1/models' && method === 'GET') return models(res)
    if (p === '/v1/chat/completions' && method === 'POST') return chat(req, res)
    if (p === '/v1/usage' && method === 'GET') return usage(req, res)
    if (p === '/' || p === '/admin' || p === '/admin/') return staticFile(res, 'index.html')
    if (p.startsWith('/admin/assets/')) return staticFile(res, p.slice('/admin/assets/'.length))
    if (p.startsWith('/admin/api/')) {
      if (!adminAllowed(req)) return sendError(res, 401, 'admin_only', 'Admin access only: open the dashboard on the machine (or through an SSH tunnel), or send the admin token.')
      return admin(req, res, url, method)
    }
    return sendError(res, 404, 'not_found', `No route for ${method} ${p}`)
  }

  // -- public ----------------------------------------------------------------

  function status(res: ServerResponse): void {
    const engines = pool.summary()
    sendJson(res, 200, {
      ok: engines.healthy > 0,
      service: 'pharo-cloud',
      version: VERSION,
      models: pool.models(),
      defaultModel: pool.resolveModel(undefined) ?? null,
      engines: { healthy: engines.healthy, total: engines.total },
      queue: { running: engines.running, waiting: engines.waiting },
      time: new Date().toISOString(),
    })
  }

  async function register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, 64 * 1024)
    const fingerprint = String(body.fingerprint ?? '').toLowerCase()
    // A SHA-256 of the machine id, made by the client: the raw id never leaves the machine.
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) return sendError(res, 400, 'invalid_fingerprint', 'fingerprint must be a SHA-256 hex digest of the machine id')
    const ip = clientIp(req, config.trustProxy)
    const now = Date.now()
    const info = { os: shortText(body.os), clientVersion: shortText(body.clientVersion) }
    const existing = store.clientByFingerprint(fingerprint)
    if (existing) {
      store.touchClient(existing.id, now, ip, info)
      return sendJson(res, 200, registration(existing, now, true))
    }
    if (store.registrationsSince(ip, now - DAY) >= config.registrationsPerIpPerDay) {
      store.raise('registration_flood', 'warning', `Many new machines from ${ip} today (limit ${config.registrationsPerIpPerDay})`, { ip }, now)
      return sendError(res, 429, 'registration_limit', 'Too many new machines from this network today. Try again tomorrow.', {}, { 'retry-after': '3600' })
    }
    const id = `pcl_${randomBytes(12).toString('base64url')}`
    store.insertClient({ id, fingerprint, plan: config.plans.defaultPlan, os: info.os ?? null, client_version: info.clientVersion ?? null, ip }, now)
    store.recordRegistration(ip, now)
    log('info', 'client registered', { client: id, ip, os: info.os, version: info.clientVersion })
    sendJson(res, 201, registration(store.clientById(id)!, now, false))
  }

  function registration(client: ClientRow, now: number, existing: boolean) {
    return { clientId: client.id, existing, plan: client.plan, usage: publicUsage(limiter.usage(client, now)), defaultModel: pool.resolveModel(undefined) ?? defaultModel(config)?.id ?? null }
  }

  function models(res: ServerResponse): void {
    const created = Math.floor(startedAt / 1000)
    sendJson(res, 200, { object: 'list', data: pool.models().map(id => ({ id, object: 'model', created, owned_by: 'pharo-cloud' })) })
  }

  function identify(req: IncomingMessage): ClientRow {
    const id = String(req.headers['x-pharo-client-id'] ?? '').trim()
    if (!id) throw new HttpError(401, 'unregistered', 'Missing X-Pharo-Client-Id. pharo-agent registers this machine automatically: run pharo-agent setup.')
    const client = store.clientById(id)
    if (!client) throw new HttpError(401, 'unregistered', 'Unknown client id. Run pharo-agent setup to register this machine again.')
    return client
  }

  async function usage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const client = identify(req)
    const now = Date.now()
    store.touchClient(client.id, now, clientIp(req, config.trustProxy))
    sendJson(res, 200, {
      clientId: client.id,
      ...publicUsage(limiter.usage(client, now)),
      last7Days: store.series(now - 7 * DAY, DAY, client.id).map(bucket => ({ day: new Date(bucket.t).toISOString().slice(0, 10), tokens: bucket.tokens, requests: bucket.requests })),
    })
  }

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const client = identify(req)
    const ip = clientIp(req, config.trustProxy)
    const body = await readJson(req)
    const started = Date.now()
    store.touchClient(client.id, started, ip)
    const model = pool.resolveModel(typeof body.model === 'string' ? body.model : undefined)
    const base = { client_id: client.id, ip, ts: started, model: model ?? (typeof body.model === 'string' ? body.model : null), stream: body.stream ? 1 : 0 }
    if (!model) {
      const served = pool.models()
      return served.length
        ? sendError(res, 404, 'model_not_found', `Unknown model "${String(body.model)}". Available: ${served.join(', ')}`)
        : sendError(res, 503, 'unavailable', 'Pharo Cloud is starting or under maintenance: no model engine is ready. Try again shortly.', {}, { 'retry-after': '15' })
    }
    const admission = limiter.admit(client, ip, started)
    if (!admission.ok) {
      store.recordRequest({ ...base, prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, ttft_ms: null, status: admission.status, error: admission.type, upstream: null })
      return sendError(res, admission.status, admission.type, admission.message, { resets_at: admission.resetsAt ? new Date(admission.resetsAt).toISOString() : undefined }, {
        ...(admission.retryAfterSec ? { 'retry-after': String(admission.retryAfterSec) } : {}),
        ...limitHeaders(limiter.usage(client, started)),
      })
    }
    if (limiter.totalInflight() >= config.maxInflight) {
      store.raise('overloaded', 'warning', `Gateway at capacity: ${config.maxInflight} requests in flight`, {}, started)
      return sendError(res, 503, 'overloaded', 'Pharo Cloud is very busy right now. Retrying in a few seconds usually works.', {}, { 'retry-after': '5' })
    }

    const requested = numberOr(body.max_tokens, numberOr(body.max_completion_tokens, undefined))
    if (admission.maxTokens !== null) body.max_tokens = Math.min(requested ?? admission.maxTokens, admission.maxTokens)
    delete body.max_completion_tokens
    body.model = model
    const stream = Boolean(body.stream)
    if (stream) body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true }

    limiter.begin(client.id, started)
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
    })
    let engine: Engine | undefined
    let upstream: Response | undefined
    const tried = new Set<Engine>()
    let lastError = ''
    let promptTokens = 0
    let completionTokens = 0
    let ttft: number | null = null
    let status = 200
    let errorText: string | null = null
    try {
      // Retry on another engine only when nothing reached the client yet.
      for (let attempt = 0; attempt < 2 && !upstream; attempt += 1) {
        engine = pool.pick(model, tried)
        if (!engine) break
        tried.add(engine)
        engine.inflight += 1
        try {
          upstream = await fetch(`${engine.url}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...pool.headers() },
            body: JSON.stringify(body),
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(config.upstreamTimeoutMs)]),
          })
        } catch (error) {
          engine.inflight -= 1
          if (abort.signal.aborted) throw error
          lastError = (error as Error).message
          pool.markFailed(engine, lastError, Date.now())
          engine = undefined
        }
      }
      if (!upstream || !engine) {
        status = 503
        errorText = lastError || 'no engine available'
        return sendError(res, 503, 'unavailable', 'No model engine could take the request. Try again in a moment.', {}, { 'retry-after': '10' })
      }
      const headers = limitHeaders(limiter.usage(client, Date.now()))
      if (!upstream.ok) {
        status = upstream.status
        const text = await upstream.text()
        errorText = text.slice(0, 500)
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', ...headers })
        return void res.end(text)
      }
      if (!stream) {
        const data = await upstream.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: { message?: { content?: string } }[] }
        ttft = Date.now() - started
        promptTokens = data.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages ?? ''))
        completionTokens = data.usage?.completion_tokens ?? estimateTokens(data.choices?.map(choice => choice.message?.content ?? '').join('') ?? '')
        // Report what is left *after* this request.
        return sendJson(res, 200, data, limitHeaders(limiter.usage(client, Date.now()), promptTokens + completionTokens))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', connection: 'keep-alive', ...headers })
      const reader = upstream.body!.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      let generated = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (ttft === null) ttft = Date.now() - started
        res.write(value)
        pending += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim()
          pending = pending.slice(newline + 1)
          if (!line.startsWith('data:') || line === 'data: [DONE]') continue
          try {
            const event = JSON.parse(line.slice(5)) as { usage?: { prompt_tokens?: number; completion_tokens?: number } | null; choices?: { delta?: { content?: string } }[] }
            if (event.usage) {
              promptTokens = event.usage.prompt_tokens ?? promptTokens
              completionTokens = event.usage.completion_tokens ?? completionTokens
            }
            for (const choice of event.choices ?? []) generated += choice.delta?.content ?? ''
          } catch {
            // partial or non-JSON line
          }
        }
      }
      if (!promptTokens && !completionTokens) {
        promptTokens = estimateTokens(JSON.stringify(body.messages ?? ''))
        completionTokens = estimateTokens(generated)
      }
      res.end()
    } catch (error) {
      if (abort.signal.aborted && !res.writableFinished) {
        status = 499 // client went away
        errorText = 'client closed the connection'
      } else {
        status = 502
        errorText = (error as Error).message
        log('error', 'upstream stream failed', { engine: engine?.url, error: errorText })
        if (!res.headersSent) sendError(res, 502, 'upstream_error', 'The model engine failed mid-request. Try again.')
        else res.end()
      }
    } finally {
      limiter.end(client.id)
      if (engine) {
        engine.inflight = Math.max(0, engine.inflight - 1)
        engine.served += 1
      }
      const now = Date.now()
      store.recordRequest({ ...base, prompt_tokens: promptTokens, completion_tokens: completionTokens, latency_ms: now - started, ttft_ms: ttft, status, error: errorText, upstream: engine?.url ?? null })
      if (status >= 500) {
        const recent = store.totals(now - 5 * 60_000).errors
        if (recent >= 10) store.raise('error_burst', 'critical', `${recent} failed requests in the last 5 minutes`, { last: errorText }, now)
      }
    }
  }

  // -- admin -----------------------------------------------------------------

  function adminAllowed(req: IncomingMessage): boolean {
    const header = String(req.headers.authorization ?? '')
    if (config.adminToken && header.startsWith('Bearer ') && safeEqual(header.slice(7), config.adminToken)) return true
    return isLoopback(req)
  }

  async function admin(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const p = url.pathname.slice('/admin/api'.length)
    const now = Date.now()
    if (p === '/overview' && method === 'GET') {
      const clients = store.listClients(now)
      return sendJson(res, 200, {
        now,
        version: VERSION,
        startedAt,
        totals: { allTime: store.allTimeTokens(), hour: store.totals(now - HOUR), day: store.totals(now - DAY), week: store.totals(now - 7 * DAY) },
        latency: store.latency(now - DAY),
        clients: { total: clients.length, active24h: clients.filter(client => client.last_seen >= now - DAY).length, blocked: clients.filter(client => client.status === 'blocked').length },
        inflight: limiter.totalInflight(),
        maxInflight: config.maxInflight,
        engines: pool.engines.map(engine => ({ ...engine })),
        machine,
        models: await modelStatuses(config),
        modelsByUsage: store.modelBreakdown(now - 7 * DAY),
        incidents: store.events(200).filter(event => event.resolved_ts === null).length,
        plans: config.plans,
      })
    }
    if (p === '/series' && method === 'GET') {
      const range = url.searchParams.get('range') ?? '24h'
      const spec: Record<string, [number, number]> = { '1h': [HOUR, 60_000], '24h': [DAY, HOUR], '7d': [7 * DAY, 6 * HOUR], '30d': [30 * DAY, DAY] }
      const [span, size] = spec[range] ?? spec['24h']!
      return sendJson(res, 200, { range, bucketMs: size, points: store.series(now - span, size, url.searchParams.get('client') ?? undefined) })
    }
    if (p === '/clients' && method === 'GET') {
      return sendJson(res, 200, store.listClients(now).map(client => ({ ...client, fingerprint: `${client.fingerprint.slice(0, 12)}…`, usage: publicUsage(limiter.usage(client, now)) })))
    }
    const clientMatch = /^\/clients\/([\w-]+)$/.exec(p)
    if (clientMatch) {
      const client = store.clientById(clientMatch[1]!)
      if (!client) return sendError(res, 404, 'not_found', 'No such client')
      if (method === 'GET') {
        return sendJson(res, 200, { client: { ...client, fingerprint: `${client.fingerprint.slice(0, 12)}…` }, usage: publicUsage(limiter.usage(client, now)), requests: store.clientRequests(client.id, 100), series: store.series(now - 7 * DAY, 6 * HOUR, client.id) })
      }
      if (method === 'PATCH') {
        const body = await readJson(req, 64 * 1024)
        const plan = typeof body.plan === 'string' ? body.plan : undefined
        if (plan && !limiter.planNames().includes(plan)) return sendError(res, 400, 'invalid_plan', `Unknown plan ${plan}. Plans: ${limiter.planNames().join(', ')}`)
        const statusValue = body.status === 'blocked' || body.status === 'active' ? body.status : undefined
        store.updateClient(client.id, { plan, status: statusValue, note: typeof body.note === 'string' ? body.note.slice(0, 500) : undefined, resetUsage: body.resetUsage === true }, now)
        log('info', 'admin changed client', { client: client.id, plan, status: statusValue, resetUsage: body.resetUsage === true })
        return sendJson(res, 200, { ok: true, client: store.clientById(client.id) })
      }
    }
    if (p === '/incidents' && method === 'GET') return sendJson(res, 200, store.events(200))
    const resolveMatch = /^\/incidents\/(\d+)\/resolve$/.exec(p)
    if (resolveMatch && method === 'POST') {
      store.db.prepare('UPDATE events SET resolved_ts = ? WHERE id = ? AND resolved_ts IS NULL').run(now, Number(resolveMatch[1]))
      return sendJson(res, 200, { ok: true })
    }
    if (p === '/errors' && method === 'GET') return sendJson(res, 200, store.recentErrors(100))
    if (p === '/logs' && method === 'GET') return sendJson(res, 200, tailLog(Math.min(1000, Number(url.searchParams.get('lines') ?? 300))))
    if (p === '/models' && method === 'GET') return sendJson(res, 200, await modelStatuses(config))
    if (p === '/engines/check' && method === 'POST') {
      await pool.checkAll()
      return sendJson(res, 200, pool.engines)
    }
    if (p === '/plans/reload' && method === 'POST') {
      try {
        const next = loadConfig().plans
        limiter.setPlans(next)
        config.plans = next
        log('info', 'plans reloaded', { plans: Object.keys(next.plans) })
        return sendJson(res, 200, { ok: true, plans: next })
      } catch (error) {
        return sendError(res, 400, 'invalid_plans', (error as Error).message)
      }
    }
    return sendError(res, 404, 'not_found', `No admin route ${method} ${p}`)
  }

  async function staticFile(res: ServerResponse, name: string): Promise<void> {
    if (!/^[\w.-]+$/.test(name)) return sendError(res, 404, 'not_found', 'Not found')
    const types: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' }
    try {
      const body = await readFile(path.join(ROOT, 'dashboard', name))
      res.writeHead(200, {
        'content-type': types[name.split('.').pop() ?? ''] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-security-policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
      })
      res.end(body)
    } catch {
      sendError(res, 404, 'not_found', 'Not found')
    }
  }

  return {
    server,
    store,
    pool,
    limiter,
    config,
    async close() {
      for (const timer of timers) clearInterval(timer)
      pool.stop()
      await new Promise<void>(resolve => server.close(() => resolve()))
      server.closeAllConnections()
      store.close()
    },
  }
}

function publicUsage(usage: Usage) {
  const iso = (value: number | null) => (value ? new Date(value).toISOString() : null)
  return {
    plan: usage.plan,
    planLabel: usage.planLabel,
    status: usage.status,
    session: { used: usage.session.used, limit: usage.session.limit, resetsAt: iso(usage.session.resetsAt), hours: usage.session.hours, active: usage.session.active },
    week: { used: usage.week.used, limit: usage.week.limit, resetsAt: iso(usage.week.resetsAt) },
    minute: usage.minute,
    concurrent: usage.concurrent,
    maxTokensPerRequest: usage.maxTokensPerRequest,
  }
}

function limitHeaders(usage: Usage, pending = 0): Record<string, string> {
  const headers: Record<string, string> = { 'x-pharo-cloud-plan': usage.plan }
  if (usage.session.limit !== null) {
    headers['x-ratelimit-limit-session-tokens'] = String(usage.session.limit)
    headers['x-ratelimit-remaining-session-tokens'] = String(Math.max(0, usage.session.limit - usage.session.used - pending))
    if (usage.session.resetsAt) headers['x-ratelimit-reset-session'] = new Date(usage.session.resetsAt).toISOString()
  }
  if (usage.week.limit !== null) {
    headers['x-ratelimit-limit-weekly-tokens'] = String(usage.week.limit)
    headers['x-ratelimit-remaining-weekly-tokens'] = String(Math.max(0, usage.week.limit - usage.week.used - pending))
  }
  return headers
}

function numberOr(value: unknown, fallback: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** Rough token count when an engine reports none (about 4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function shortText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, 120) : undefined
}
