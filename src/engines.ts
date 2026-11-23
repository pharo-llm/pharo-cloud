import type { CloudConfig } from './config.ts'
import { defaultModel } from './config.ts'
import type { Store } from './db.ts'
import { log } from './log.ts'

export type EngineKind = 'vllm' | 'llama.cpp' | 'openai-compatible'

export type EngineMetrics = {
  running: number
  waiting: number
  /** 0..1 */
  kvCacheUsage: number | null
  promptTokensTotal: number
  generationTokensTotal: number
  /** Generated tokens per second since the previous scrape. */
  generationTps: number | null
  at: number
}

export type Engine = {
  url: string
  root: string
  kind: EngineKind
  healthy: boolean
  models: string[]
  inflight: number
  served: number
  failures: number
  lastError?: string
  lastCheck: number
  since: number
  metrics?: EngineMetrics
}

/** Parse Prometheus text: sum every sample of each metric name (across labels). */
export function parsePrometheus(text: string): Map<string, number> {
  const sums = new Map<string, number>()
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+([-+0-9.eEInfNa]+)/.exec(line)
    if (!match) continue
    const value = Number(match[3])
    if (!Number.isFinite(value)) continue
    sums.set(match[1]!, (sums.get(match[1]!) ?? 0) + value)
  }
  return sums
}

/** vLLM and llama.cpp name the same things differently. */
export function engineMetrics(samples: Map<string, number>, previous: EngineMetrics | undefined, now: number): { kind: EngineKind; metrics: EngineMetrics } | undefined {
  const first = (...names: string[]) => names.map(name => samples.get(name)).find(value => value !== undefined)
  let kind: EngineKind
  let metrics: Omit<EngineMetrics, 'generationTps' | 'at'>
  if ([...samples.keys()].some(name => name.startsWith('vllm:'))) {
    kind = 'vllm'
    metrics = {
      running: first('vllm:num_requests_running') ?? 0,
      waiting: first('vllm:num_requests_waiting') ?? 0,
      kvCacheUsage: first('vllm:kv_cache_usage_perc', 'vllm:gpu_cache_usage_perc') ?? null,
      promptTokensTotal: first('vllm:prompt_tokens_total') ?? 0,
      generationTokensTotal: first('vllm:generation_tokens_total') ?? 0,
    }
  } else if ([...samples.keys()].some(name => name.startsWith('llamacpp:'))) {
    kind = 'llama.cpp'
    metrics = {
      running: first('llamacpp:requests_processing') ?? 0,
      waiting: first('llamacpp:requests_deferred') ?? 0,
      kvCacheUsage: first('llamacpp:kv_cache_usage_ratio') ?? null,
      promptTokensTotal: first('llamacpp:prompt_tokens_total') ?? 0,
      generationTokensTotal: first('llamacpp:tokens_predicted_total') ?? 0,
    }
  } else return undefined
  const seconds = previous ? (now - previous.at) / 1_000 : 0
  const generationTps = previous && seconds > 0 ? Math.max(0, (metrics.generationTokensTotal - previous.generationTokensTotal) / seconds) : null
  return { kind, metrics: { ...metrics, generationTps, at: now } }
}

export class EnginePool {
  readonly engines: Engine[]
  private readonly config: CloudConfig
  private readonly store: Store
  private timer?: NodeJS.Timeout

  constructor(config: CloudConfig, store: Store) {
    this.config = config
    this.store = store
    const now = Date.now()
    this.engines = config.upstreams.map(url => ({
      url,
      root: url.replace(/\/v1$/, ''),
      kind: 'openai-compatible' as EngineKind,
      healthy: false,
      models: [],
      inflight: 0,
      served: 0,
      failures: 0,
      lastCheck: 0,
      since: now,
    }))
  }

  start(intervalMs = 5_000): void {
    void this.checkAll()
    this.timer = setInterval(() => void this.checkAll(), intervalMs)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
  }

  headers(): Record<string, string> {
    return this.config.upstreamApiKey ? { authorization: `Bearer ${this.config.upstreamApiKey}` } : {}
  }

  async checkAll(): Promise<void> {
    await Promise.all(this.engines.map(engine => this.check(engine)))
  }

  private async check(engine: Engine): Promise<void> {
    const now = Date.now()
    engine.lastCheck = now
    try {
      const response = await fetch(`${engine.url}/models`, { headers: this.headers(), signal: AbortSignal.timeout(4_000) })
      if (!response.ok) throw new Error(`GET /models answered HTTP ${response.status}`)
      const data = await response.json() as { data?: { id?: string }[] }
      engine.models = (data.data ?? []).map(item => item.id).filter((id): id is string => Boolean(id))
      this.markHealthy(engine, now)
    } catch (error) {
      this.markFailed(engine, (error as Error).message, now)
      return
    }
    try {
      const response = await fetch(`${engine.root}/metrics`, { headers: this.headers(), signal: AbortSignal.timeout(4_000) })
      if (response.ok) {
        const parsed = engineMetrics(parsePrometheus(await response.text()), engine.metrics, now)
        if (parsed) {
          engine.kind = parsed.kind
          engine.metrics = parsed.metrics
        }
      }
    } catch {
      // metrics are optional (e.g. llama.cpp without --metrics)
    }
  }

  markHealthy(engine: Engine, now: number): void {
    if (!engine.healthy) {
      log('info', 'engine up', { engine: engine.url, models: engine.models })
      engine.since = now
      this.store.resolve(`engine_down:${engine.url}`, now)
    }
    engine.healthy = true
    engine.failures = 0
  }

  markFailed(engine: Engine, message: string, now: number): void {
    engine.failures += 1
    engine.lastError = message
    // Two misses in a row before declaring it down: one slow probe is not an outage.
    if (engine.healthy && engine.failures < 2) return
    if (engine.healthy) log('error', 'engine down', { engine: engine.url, error: message })
    if (engine.healthy || engine.failures === 1) engine.since = now
    engine.healthy = false
    this.store.raise(`engine_down:${engine.url}`, 'critical', `Engine ${engine.url} is not answering: ${message}`, { engine: engine.url }, now)
  }

  /** Every model any healthy engine serves. */
  models(): string[] {
    return [...new Set(this.engines.filter(engine => engine.healthy).flatMap(engine => engine.models))]
  }

  /**
   * The model to run: the one asked for if an engine serves it; otherwise the
   * configured default (clients may say "default" or nothing at all).
   */
  resolveModel(requested: string | undefined): string | undefined {
    const served = this.models()
    if (requested && served.includes(requested)) return requested
    if (requested && requested !== 'default' && !this.config.models.some(model => model.id === requested)) return undefined
    const preferred = defaultModel(this.config)?.id
    if (preferred && served.includes(preferred)) return preferred
    return served[0]
  }

  /** Least busy healthy engine serving `model`, skipping `exclude`. */
  pick(model: string, exclude: Set<Engine> = new Set()): Engine | undefined {
    const candidates = this.engines.filter(engine => engine.healthy && engine.models.includes(model) && !exclude.has(engine))
    candidates.sort((a, b) => (a.inflight + (a.metrics?.waiting ?? 0)) - (b.inflight + (b.metrics?.waiting ?? 0)))
    return candidates[0]
  }

  summary(): { healthy: number; total: number; running: number; waiting: number } {
    return {
      healthy: this.engines.filter(engine => engine.healthy).length,
      total: this.engines.length,
      running: this.engines.reduce((sum, engine) => sum + (engine.metrics?.running ?? engine.inflight), 0),
      waiting: this.engines.reduce((sum, engine) => sum + (engine.metrics?.waiting ?? 0), 0),
    }
  }
}
