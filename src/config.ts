import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.1.0'
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Limits for one machine (client). null = unlimited. */
export type Plan = {
  label: string
  /** Length of the rolling session window, like Claude's 5-hour sessions. */
  sessionHours: number
  tokensPerSession: number | null
  tokensPerWeek: number | null
  requestsPerMinute: number | null
  maxConcurrent: number | null
  maxTokensPerRequest: number | null
}

export type Plans = {
  defaultPlan: string
  /** Limits per IP address = this × the default plan (slows down ID cycling). null = off. */
  perIpMultiplier: number | null
  plans: Record<string, Plan>
}

export type ModelSpec = {
  /** Name clients use ("model": "pharo-coder"). */
  id: string
  repo: string
  files: string[]
  tokenizer?: string
  contextLength?: number
  default?: boolean
}

export type CloudConfig = {
  host: string
  port: number
  dbPath: string
  /** Where GGUF files are downloaded (shared with the engine). */
  modelsDir: string
  models: ModelSpec[]
  /** Engine base URLs (vLLM or llama.cpp, OpenAI-compatible), e.g. http://vllm:8000/v1 */
  upstreams: string[]
  upstreamApiKey?: string
  /** Optional: admin from anywhere with this bearer token. Without it, admin is loopback-only. */
  adminToken?: string
  /** New client IDs per IP address per day. */
  registrationsPerIpPerDay: number
  /** Requests in flight across all clients before new ones get 503. */
  maxInflight: number
  trustProxy: boolean
  upstreamTimeoutMs: number
  /** Log file shown in the admin dashboard. */
  logPath: string
  plans: Plans
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const plans = JSON.parse(readFileSync(env.PHARO_CLOUD_PLANS ?? path.join(ROOT, 'config', 'plans.json'), 'utf8')) as Plans
  validatePlans(plans)
  const models = (JSON.parse(readFileSync(env.PHARO_CLOUD_MODELS ?? path.join(ROOT, 'config', 'models.json'), 'utf8')) as { models: ModelSpec[] }).models
  const dataDir = env.PHARO_CLOUD_DATA ?? path.join(ROOT, 'data')
  return {
    host: env.HOST ?? env.PHARO_CLOUD_HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? env.PHARO_CLOUD_PORT ?? 8000),
    dbPath: env.PHARO_CLOUD_DB ?? path.join(dataDir, 'pharo-cloud.db'),
    modelsDir: env.PHARO_CLOUD_MODELS_DIR ?? path.join(dataDir, 'models'),
    models,
    upstreams: (env.PHARO_CLOUD_UPSTREAMS ?? 'http://127.0.0.1:8001/v1').split(',').map(url => url.trim().replace(/\/$/, '')).filter(Boolean),
    upstreamApiKey: env.PHARO_CLOUD_UPSTREAM_API_KEY || undefined,
    adminToken: env.PHARO_CLOUD_ADMIN_TOKEN || undefined,
    registrationsPerIpPerDay: Number(env.PHARO_CLOUD_REGISTRATIONS_PER_IP ?? 10),
    maxInflight: Number(env.PHARO_CLOUD_MAX_INFLIGHT ?? 256),
    trustProxy: ['1', 'true', 'yes'].includes(String(env.PHARO_CLOUD_TRUST_PROXY ?? '').toLowerCase()),
    upstreamTimeoutMs: Number(env.PHARO_CLOUD_UPSTREAM_TIMEOUT ?? 600) * 1_000,
    logPath: env.PHARO_CLOUD_LOG ?? path.join(dataDir, 'gateway.log'),
    plans,
  }
}

export function validatePlans(plans: Plans): void {
  if (!plans.plans?.[plans.defaultPlan]) throw new Error(`plans.json: defaultPlan "${plans.defaultPlan}" is not defined`)
  for (const [name, plan] of Object.entries(plans.plans)) {
    if (!(plan.sessionHours > 0)) throw new Error(`plans.json: ${name}.sessionHours must be > 0`)
    for (const key of ['tokensPerSession', 'tokensPerWeek', 'requestsPerMinute', 'maxConcurrent', 'maxTokensPerRequest'] as const) {
      const value = plan[key]
      if (value !== null && (typeof value !== 'number' || value < 0)) throw new Error(`plans.json: ${name}.${key} must be a number >= 0 or null`)
    }
  }
}

export function defaultModel(config: CloudConfig): ModelSpec | undefined {
  return config.models.find(model => model.default) ?? config.models[0]
}
