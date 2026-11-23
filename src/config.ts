import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.1.0'
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export type Plan = {
  label: string
  /** null = unlimited */
  requestsPerMinute: number | null
  tokensPerDay: number | null
  tokensPerMonth: number | null
  maxConcurrent: number | null
  maxTokensPerRequest: number | null
}

export type Plans = { defaultPlan: string; plans: Record<string, Plan> }

export type RegistrationMode = 'open' | 'invite' | 'closed'

export type CloudConfig = {
  host: string
  port: number
  /** Public URL, used in links (dashboard) handed to clients. */
  publicUrl: string
  dbPath: string
  /** vLLM OpenAI-compatible base URLs, e.g. http://vllm-0:8000/v1 */
  upstreams: string[]
  upstreamApiKey?: string
  /** Model clients get when they ask for "default" or nothing. */
  defaultModel?: string
  adminToken?: string
  registration: RegistrationMode
  inviteCodes: string[]
  /** New clients per IP per day (fingerprint re-registrations don't count). */
  registrationsPerIpPerDay: number
  /** Requests in flight across all clients before new ones get 503. */
  maxInflight: number
  /** Trust X-Forwarded-For (behind a reverse proxy). */
  trustProxy: boolean
  /** Upstream request timeout. */
  upstreamTimeoutMs: number
  plans: Plans
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const plansFile = env.PHARO_CLOUD_PLANS ?? path.join(ROOT, 'config', 'plans.json')
  const plans = JSON.parse(readFileSync(plansFile, 'utf8')) as Plans
  validatePlans(plans)
  const port = Number(env.PORT ?? env.PHARO_CLOUD_PORT ?? 8000)
  const registration = (env.PHARO_CLOUD_REGISTRATION ?? 'open') as RegistrationMode
  if (!['open', 'invite', 'closed'].includes(registration)) throw new Error(`PHARO_CLOUD_REGISTRATION must be open, invite or closed (got ${registration})`)
  return {
    host: env.HOST ?? env.PHARO_CLOUD_HOST ?? '0.0.0.0',
    port,
    publicUrl: (env.PHARO_CLOUD_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, ''),
    dbPath: env.PHARO_CLOUD_DB ?? path.join(ROOT, 'data', 'pharo-cloud.db'),
    upstreams: (env.PHARO_CLOUD_UPSTREAMS ?? 'http://127.0.0.1:8001/v1').split(',').map(url => url.trim().replace(/\/$/, '')).filter(Boolean),
    upstreamApiKey: env.PHARO_CLOUD_UPSTREAM_API_KEY || undefined,
    defaultModel: env.PHARO_CLOUD_DEFAULT_MODEL || undefined,
    adminToken: env.PHARO_CLOUD_ADMIN_TOKEN || undefined,
    registration,
    inviteCodes: (env.PHARO_CLOUD_INVITE_CODES ?? '').split(',').map(code => code.trim()).filter(Boolean),
    registrationsPerIpPerDay: Number(env.PHARO_CLOUD_REGISTRATIONS_PER_IP ?? 10),
    maxInflight: Number(env.PHARO_CLOUD_MAX_INFLIGHT ?? 256),
    trustProxy: ['1', 'true', 'yes'].includes(String(env.PHARO_CLOUD_TRUST_PROXY ?? '').toLowerCase()),
    upstreamTimeoutMs: Number(env.PHARO_CLOUD_UPSTREAM_TIMEOUT ?? 600) * 1_000,
    plans,
  }
}

function validatePlans(plans: Plans): void {
  if (!plans.plans?.[plans.defaultPlan]) throw new Error(`plans.json: defaultPlan "${plans.defaultPlan}" is not defined`)
  for (const [name, plan] of Object.entries(plans.plans)) {
    for (const key of ['requestsPerMinute', 'tokensPerDay', 'tokensPerMonth', 'maxConcurrent', 'maxTokensPerRequest'] as const) {
      const value = plan[key]
      if (value !== null && (typeof value !== 'number' || value < 0)) throw new Error(`plans.json: ${name}.${key} must be a number >= 0 or null`)
    }
  }
}
