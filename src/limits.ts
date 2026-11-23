import type { Plan, Plans } from './config.ts'
import type { ClientRow, Store } from './db.ts'
import { DAY, HOUR } from './db.ts'

const WEEK = 7 * DAY

export type Window = { used: number; limit: number | null; resetsAt: number | null }

export type Usage = {
  plan: string
  planLabel: string
  status: ClientRow['status']
  /** Claude-style session: starts with the first request, lasts plan.sessionHours. */
  session: Window & { hours: number; active: boolean }
  week: Window
  minute: { used: number; limit: number | null }
  concurrent: { used: number; limit: number | null }
  maxTokensPerRequest: number | null
}

export type Denial = {
  ok: false
  status: 403 | 429
  type: 'blocked' | 'session_limit' | 'weekly_limit' | 'rate_limit' | 'concurrency_limit' | 'ip_limit'
  message: string
  retryAfterSec?: number
  resetsAt?: number
}

export type Admission = { ok: true; maxTokens: number | null } | Denial

export class Limiter {
  private readonly store: Store
  private plans: Plans
  private readonly minute = new Map<string, number[]>()
  private readonly inflight = new Map<string, number>()

  constructor(store: Store, plans: Plans) {
    this.store = store
    this.plans = plans
  }

  plan(client: ClientRow): Plan {
    return this.plans.plans[client.plan] ?? this.plans.plans[this.plans.defaultPlan]!
  }

  setPlans(plans: Plans): void {
    this.plans = plans
  }

  planNames(): string[] {
    return Object.keys(this.plans.plans)
  }

  usage(client: ClientRow, now: number): Usage {
    const plan = this.plan(client)
    const sessionMs = plan.sessionHours * HOUR
    const active = client.session_start !== null && now < client.session_start + sessionMs
    const sessionUsed = active ? this.store.clientTokensSince(client.id, client.session_start!) : 0
    const weekUsed = this.store.clientTokensSince(client.id, now - WEEK)
    const oldest = this.store.clientOldestSince(client.id, now - WEEK)
    return {
      plan: client.plan,
      planLabel: plan.label,
      status: client.status,
      session: { used: sessionUsed, limit: plan.tokensPerSession, resetsAt: active ? client.session_start! + sessionMs : null, hours: plan.sessionHours, active },
      week: { used: weekUsed, limit: plan.tokensPerWeek, resetsAt: oldest ? oldest + WEEK : null },
      minute: { used: this.recentCount(client.id, now), limit: plan.requestsPerMinute },
      concurrent: { used: this.inflight.get(client.id) ?? 0, limit: plan.maxConcurrent },
      maxTokensPerRequest: plan.maxTokensPerRequest,
    }
  }

  /** Decide whether a request may start. On success, starts the session if needed. */
  admit(client: ClientRow, ip: string, now: number): Admission {
    if (client.status === 'blocked') return { ok: false, status: 403, type: 'blocked', message: 'This machine has been blocked by the Pharo Cloud administrator.' }
    const usage = this.usage(client, now)
    if (usage.session.limit !== null && usage.session.used >= usage.session.limit) {
      return denial('session_limit', `You reached your ${usage.session.hours}-hour usage limit (${fmt(usage.session.limit)} tokens).`, usage.session.resetsAt, now)
    }
    if (usage.week.limit !== null && usage.week.used >= usage.week.limit) {
      return denial('weekly_limit', `You reached your weekly usage limit (${fmt(usage.week.limit)} tokens).`, usage.week.resetsAt, now)
    }
    if (usage.minute.limit !== null && usage.minute.used >= usage.minute.limit) {
      const oldest = this.minute.get(client.id)?.[0] ?? now
      return denial('rate_limit', `Too many requests: ${usage.minute.limit} per minute.`, oldest + 60_000, now)
    }
    if (usage.concurrent.limit !== null && usage.concurrent.used >= usage.concurrent.limit) {
      return { ok: false, status: 429, type: 'concurrency_limit', message: `Too many requests at once (${usage.concurrent.limit} max). Wait for one to finish.`, retryAfterSec: 2 }
    }
    const ipLimit = this.ipWeeklyLimit()
    if (ipLimit !== null && this.store.ipTokensSince(ip, now - WEEK) >= ipLimit) {
      return denial('ip_limit', `Too much usage from this network address this week (${fmt(ipLimit)} tokens).`, now + DAY, now)
    }
    if (!usage.session.active) this.store.setSessionStart(client.id, now)
    const remaining = [
      usage.session.limit === null ? null : usage.session.limit - usage.session.used,
      usage.week.limit === null ? null : usage.week.limit - usage.week.used,
      usage.maxTokensPerRequest,
    ].filter((value): value is number => value !== null)
    return { ok: true, maxTokens: remaining.length ? Math.max(1, Math.min(...remaining)) : null }
  }

  begin(clientId: string, now: number): void {
    const list = this.minute.get(clientId) ?? []
    list.push(now)
    this.minute.set(clientId, list)
    this.inflight.set(clientId, (this.inflight.get(clientId) ?? 0) + 1)
  }

  end(clientId: string): void {
    const value = (this.inflight.get(clientId) ?? 1) - 1
    if (value <= 0) this.inflight.delete(clientId)
    else this.inflight.set(clientId, value)
  }

  totalInflight(): number {
    let total = 0
    for (const value of this.inflight.values()) total += value
    return total
  }

  private recentCount(clientId: string, now: number): number {
    const list = (this.minute.get(clientId) ?? []).filter(ts => ts > now - 60_000)
    if (list.length) this.minute.set(clientId, list)
    else this.minute.delete(clientId)
    return list.length
  }

  private ipWeeklyLimit(): number | null {
    const multiplier = this.plans.perIpMultiplier
    const base = this.plans.plans[this.plans.defaultPlan]!.tokensPerWeek
    return multiplier === null || base === null ? null : multiplier * base
  }
}

function denial(type: Denial['type'], message: string, resetsAt: number | null, now: number): Denial {
  const retryAfterSec = resetsAt ? Math.max(1, Math.ceil((resetsAt - now) / 1_000)) : undefined
  return { ok: false, status: 429, type, message: `${message}${retryAfterSec ? ` It resets in ${duration(retryAfterSec)}.` : ''}`, retryAfterSec, resetsAt: resetsAt ?? undefined }
}

export function duration(seconds: number): string {
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.round(hours / 24)} days`
}

function fmt(value: number): string {
  return value.toLocaleString('en-US')
}
