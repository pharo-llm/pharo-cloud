import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/app.ts'
import type { App } from '../src/app.ts'
import type { CloudConfig, Plans } from '../src/config.ts'
import { engineMetrics, parsePrometheus } from '../src/engines.ts'
import { parseNvidiaSmi } from '../src/machine.ts'

process.env.PHARO_CLOUD_QUIET = '1'

/** A fake vLLM: /v1/models, /v1/chat/completions (stream or not, with usage), /metrics. */
async function fakeVllm(options: { delayMs?: number } = {}) {
  let calls = 0
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'pharo-coder' }] }))
    if (req.url === '/metrics') return res.end('# HELP x\nvllm:num_requests_running{model_name="pharo-coder"} 2\nvllm:num_requests_waiting{model_name="pharo-coder"} 1\nvllm:kv_cache_usage_perc 0.25\nvllm:generation_tokens_total 1000\nvllm:prompt_tokens_total 400\n')
    if (req.url === '/v1/chat/completions') {
      calls += 1
      let body = ''
      for await (const chunk of req) body += chunk
      const request = JSON.parse(body) as { stream?: boolean; max_tokens?: number; stream_options?: { include_usage?: boolean } }
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))
      if (!request.stream) {
        return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }], usage: { prompt_tokens: 40, completion_tokens: 60 }, echo_max_tokens: request.max_tokens }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n')
      if (request.stream_options?.include_usage) res.write('data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":20}}\n\n')
      return res.end('data: [DONE]\n\n')
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, server, calls: () => calls }
}

const plans: Plans = {
  defaultPlan: 'standard',
  perIpMultiplier: null,
  plans: {
    standard: { label: 'Standard', sessionHours: 5, tokensPerSession: 250, tokensPerWeek: 10_000, requestsPerMinute: 100, maxConcurrent: 2, maxTokensPerRequest: 512 },
    unlimited: { label: 'Unlimited', sessionHours: 5, tokensPerSession: null, tokensPerWeek: null, requestsPerMinute: null, maxConcurrent: null, maxTokensPerRequest: null },
  },
}

async function withGateway(upstreams: string[], run: (base: string, app: App) => Promise<void>, overrides: Partial<CloudConfig> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pharo-cloud-test-'))
  const config: CloudConfig = {
    host: '127.0.0.1', port: 0, dbPath: path.join(dir, 'db.sqlite'), modelsDir: path.join(dir, 'models'),
    models: [{ id: 'pharo-coder', repo: 'x/y', files: ['m.gguf'], default: true }],
    upstreams, registrationsPerIpPerDay: 5, maxInflight: 100, trustProxy: false, upstreamTimeoutMs: 10_000,
    logPath: path.join(dir, 'gateway.log'), plans: structuredClone(plans), ...overrides,
  }
  const app = createApp(config, { monitors: false })
  await app.pool.checkAll()
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, app)
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
}

const fingerprint = (name: string) => createHash('sha256').update(name).digest('hex')

async function register(base: string, name = 'machine-a'): Promise<string> {
  const response = await fetch(`${base}/v1/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fingerprint: fingerprint(name), os: 'linux' }) })
  return ((await response.json()) as { clientId: string }).clientId
}

function chat(base: string, id: string, body: Record<string, unknown> = {}) {
  return fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pharo-client-id': id }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body }) })
}

test('the same machine always gets the same client id', async () => {
  const engine = await fakeVllm()
  try {
    await withGateway([engine.url], async base => {
      const first = await register(base)
      assert.match(first, /^pcl_/)
      assert.equal(await register(base), first)
      assert.notEqual(await register(base, 'machine-b'), first)
      const bad = await fetch(`${base}/v1/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fingerprint: 'raw-machine-id' }) })
      assert.equal(bad.status, 400)
    })
  } finally {
    engine.server.close()
  }
})

test('requests need a registered client id', async () => {
  const engine = await fakeVllm()
  try {
    await withGateway([engine.url], async base => {
      assert.equal((await chat(base, '')).status, 401)
      assert.equal((await chat(base, 'pcl_unknown')).status, 401)
    })
  } finally {
    engine.server.close()
  }
})

test('meters tokens for normal and streaming requests, and clamps max_tokens', async () => {
  const engine = await fakeVllm()
  try {
    await withGateway([engine.url], async (base, app) => {
      const id = await register(base)
      const response = await chat(base, id, { max_tokens: 100_000 })
      assert.equal(response.status, 200)
      const data = await response.json() as { echo_max_tokens: number }
      assert.equal(data.echo_max_tokens, 250, 'max_tokens clamped to what the session has left')
      assert.equal(response.headers.get('x-ratelimit-remaining-session-tokens'), '150')
      const stream = await chat(base, id, { stream: true })
      const text = await stream.text()
      assert.match(text, /\[DONE\]/)
      assert.equal(app.store.clientTokensSince(id, 0), 150)
      const usage = await (await fetch(`${base}/v1/usage`, { headers: { 'x-pharo-client-id': id } })).json() as { session: { used: number; limit: number; resetsAt: string } }
      assert.equal(usage.session.used, 150)
      assert.ok(Date.parse(usage.session.resetsAt) > Date.now() + 4 * 3_600_000)
    })
  } finally {
    engine.server.close()
  }
})

test('the 5-hour session limit answers 429 with a reset time', async () => {
  const engine = await fakeVllm()
  try {
    await withGateway([engine.url], async base => {
      const id = await register(base)
      for (let i = 0; i < 3; i += 1) await chat(base, id)
      const limited = await chat(base, id)
      assert.equal(limited.status, 429)
      assert.ok(Number(limited.headers.get('retry-after')) > 4 * 3600)
      const body = await limited.json() as { error: { type: string; message: string; resets_at: string } }
      assert.equal(body.error.type, 'session_limit')
      assert.match(body.error.message, /5-hour usage limit/)
    })
  } finally {
    engine.server.close()
  }
})

test('admin can block a machine and change its plan', async () => {
  const engine = await fakeVllm()
  try {
    await withGateway([engine.url], async base => {
      const id = await register(base)
      const patch = (body: unknown) => fetch(`${base}/admin/api/clients/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal((await patch({ status: 'blocked' })).status, 200)
      assert.equal((await chat(base, id)).status, 403)
      await patch({ status: 'active', plan: 'unlimited' })
      for (let i = 0; i < 4; i += 1) assert.equal((await chat(base, id)).status, 200)
      assert.equal((await patch({ plan: 'nope' })).status, 400)
    })
  } finally {
    engine.server.close()
  }
})

test('admin API is loopback-only unless the admin token is sent', async () => {
  const engine = await fakeVllm()
  try {
    await withGateway([engine.url], async base => {
      // Tests connect over loopback: allowed.
      assert.equal((await fetch(`${base}/admin/api/overview`)).status, 200)
      const overview = await (await fetch(`${base}/admin/api/overview`)).json() as { engines: { kind: string; metrics: { running: number; kvCacheUsage: number } }[] }
      assert.equal(overview.engines[0]!.kind, 'vllm')
      assert.equal(overview.engines[0]!.metrics.running, 2)
      assert.equal(overview.engines[0]!.metrics.kvCacheUsage, 0.25)
    }, { adminToken: 'secret' })
  } finally {
    engine.server.close()
  }
})

test('fails over to a healthy engine and reports an outage', async () => {
  const engine = await fakeVllm()
  try {
    await withGateway(['http://127.0.0.1:1/v1', engine.url], async (base, app) => {
      await app.pool.checkAll()
      const id = await register(base)
      assert.equal((await chat(base, id)).status, 200)
      assert.ok(app.store.events().some(event => event.kind.startsWith('engine_down') && event.severity === 'critical'))
    })
  } finally {
    engine.server.close()
  }
})

test('concurrent requests beyond the plan get 429 concurrency_limit', async () => {
  const engine = await fakeVllm({ delayMs: 300 })
  try {
    await withGateway([engine.url], async base => {
      const id = await register(base)
      const statuses = await Promise.all([0, 1, 2].map(() => chat(base, id, { max_tokens: 10 }).then(response => response.status)))
      assert.deepEqual(statuses.sort(), [200, 200, 429])
    })
  } finally {
    engine.server.close()
  }
})

test('no engine at all answers 503 with retry-after', async () => {
  await withGateway(['http://127.0.0.1:1/v1'], async base => {
    const id = await register(base)
    const response = await chat(base, id)
    assert.equal(response.status, 503)
    assert.ok(response.headers.get('retry-after'))
  })
})

test('parses vLLM and llama.cpp metrics, and nvidia-smi', () => {
  const vllm = engineMetrics(parsePrometheus('vllm:num_requests_running{a="1"} 3\nvllm:num_requests_running{a="2"} 1\nvllm:generation_tokens_total 100\n'), { running: 0, waiting: 0, kvCacheUsage: null, promptTokensTotal: 0, generationTokensTotal: 50, generationTps: null, at: 0 }, 10_000)
  assert.equal(vllm?.kind, 'vllm')
  assert.equal(vllm?.metrics.running, 4)
  assert.equal(vllm?.metrics.generationTps, 5)
  const llama = engineMetrics(parsePrometheus('llamacpp:requests_processing 2\nllamacpp:tokens_predicted_total 9\n'), undefined, 1)
  assert.equal(llama?.kind, 'llama.cpp')
  assert.equal(llama?.metrics.running, 2)
  const [gpu] = parseNvidiaSmi('0, NVIDIA L40S, 87, 40000, 46068, 71, 280.5\n')
  assert.deepEqual(gpu, { index: 0, name: 'NVIDIA L40S', utilization: 87, memoryUsedMb: 40000, memoryTotalMb: 46068, temperature: 71, powerW: 280.5 })
})
