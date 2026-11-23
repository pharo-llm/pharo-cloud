// Pharo Cloud admin dashboard. No framework, no build step.
// Every value from the API is inserted with textContent.

const state = {
  range: '24h',
  paused: false,
  token: sessionStorage.getItem('pharo-cloud-admin-token') ?? '',
  overview: null,
  series: null,
  clients: [],
  incidents: [],
  errors: [],
  logs: [],
  showTable: {},
  showResolved: false,
}
const RANGES = { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' }
const app = document.getElementById('app')

// ---------------------------------------------------------------------------
// tiny DOM helpers

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}
const svgNs = 'http://www.w3.org/2000/svg'
function svg(tag, attrs = {}) {
  const node = document.createElementNS(svgNs, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

// ---------------------------------------------------------------------------
// formatting

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const full = new Intl.NumberFormat('en-US')
function num(value) { return value === null || value === undefined ? '–' : Math.abs(value) >= 10000 ? compact.format(value) : full.format(Math.round(value)) }
function bytes(value) {
  if (value === null || value === undefined) return '–'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = value, i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1 }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}
function ms(value) { return value === null || value === undefined ? '–' : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms` }
function ago(ts) {
  if (!ts) return '–'
  const s = Math.round((Date.now() - (typeof ts === 'string' ? Date.parse(ts) : ts)) / 1000)
  if (s < 0) return `in ${dur(-s)}`
  if (s < 60) return `${s}s ago`
  return `${dur(s)} ago`
}
function dur(s) {
  if (s < 90) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)} days`
}
function time(ts) { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function pct(part, whole) { return whole ? part / whole : 0 }

// ---------------------------------------------------------------------------
// API

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) }
  const response = await fetch(`/admin/api${path}`, { ...options, headers })
  if (response.status === 401) throw Object.assign(new Error('unauthorized'), { status: 401 })
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error?.message ?? `HTTP ${response.status}`)
  return response.json()
}

async function refresh() {
  if (state.paused) return
  app.classList.add('stale')
  try {
    const [overview, series, clients, incidents, errors, logs] = await Promise.all([
      api('/overview'), api(`/series?range=${state.range}`), api('/clients'), api('/incidents'), api('/errors'), api('/logs?lines=200'),
    ])
    Object.assign(state, { overview, series, clients, incidents, errors, logs })
  } catch (error) {
    app.classList.remove('stale')
    if (error.status === 401) return renderLogin()
    document.getElementById('updated').textContent = `Update failed: ${error.message}`
    setHealth('critical', 'Gateway unreachable')
    return
  }
  try {
    render()
    document.getElementById('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`
  } catch (error) {
    // A bug in this page, not an outage: say so.
    console.error(error)
    document.getElementById('updated').textContent = `Dashboard error: ${error.message}`
  } finally {
    app.classList.remove('stale')
  }
}

function setHealth(kind, label) {
  const node = document.getElementById('health')
  node.className = `status ${kind}`
  node.textContent = label
}

// ---------------------------------------------------------------------------
// login (only off the machine, when an admin token is configured)

function renderLogin() {
  setHealth('muted', 'Sign in required')
  const input = el('input', { type: 'password', placeholder: 'Admin token (PHARO_CLOUD_ADMIN_TOKEN)', autocomplete: 'off' })
  app.replaceChildren(el('div', { class: 'card login' },
    el('h2', {}, 'Admin access'),
    el('p', { class: 'sub' }, 'Open this page on the machine itself (or through an SSH tunnel) to skip this, or enter the admin token.'),
    el('form', { onsubmit: event => { event.preventDefault(); state.token = input.value.trim(); sessionStorage.setItem('pharo-cloud-admin-token', state.token); refresh() } },
      input, el('button', { class: 'btn', type: 'submit' }, 'Open dashboard'))))
  input.focus()
}

// ---------------------------------------------------------------------------
// building blocks

function tile(label, value, context) {
  return el('div', { class: 'card tile' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value), context ? el('div', { class: 'context' }, context) : null)
}

/** Meter: fill severity by share; track is the lighter step of the same ramp. */
function meter(label, used, limit, text) {
  const share = limit ? Math.min(1, used / limit) : 0
  const level = share >= 0.9 ? 'critical' : share >= 0.75 ? 'warning' : ''
  const fill = el('i')
  fill.style.width = `${(share * 100).toFixed(1)}%`
  return el('div', { class: `meter ${level}` },
    el('div', { class: 'row' }, el('span', {}, label), el('span', {}, text ?? (limit ? `${num(used)} / ${num(limit)}` : `${num(used)} · no limit`))),
    el('div', { class: 'bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': limit ?? 0, 'aria-valuenow': used, 'aria-label': label }, fill))
}

function statusOf(severity) { return severity === 'critical' ? 'critical' : severity === 'warning' ? 'warning' : 'muted' }

/**
 * Column chart: one or two stacked series, 24px max columns, 4px rounded top,
 * square baseline, 2px surface gap, hairline grid, hover/focus tooltip, table view.
 */
function columnChart(id, points, series, label) {
  const wrap = el('div', { class: 'chart' })
  const showTable = state.showTable[id]
  const swatch = s => {
    const node = el('i')
    node.style.background = s.cls === 'failed' ? 'var(--critical)' : 'var(--series-1)'
    return node
  }
  // A legend only when there is more than one series (one series: the title names it).
  const header = el('div', { class: 'legend' },
    series.length > 1 ? series.map(s => el('span', {}, swatch(s), s.label)) : null,
    el('button', { class: 'btn toggle-table', type: 'button', onclick: () => { state.showTable[id] = !showTable; render() } }, showTable ? 'Show chart' : 'Show table'))
  if (showTable) {
    return el('div', {}, header, el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Time'), series.map(s => el('th', { class: 'num' }, s.label)))),
      el('tbody', {}, points.filter(p => series.some(s => s.value(p))).reverse().map(p => el('tr', {}, el('td', {}, label(p.t)), series.map(s => el('td', { class: 'num' }, full.format(s.value(p))))))))))
  }
  const width = 800, height = 220, left = 44, bottom = 22, top = 8
  const max = Math.max(1, ...points.map(p => series.reduce((sum, s) => sum + s.value(p), 0)))
  const nice = niceMax(max)
  const plotW = width - left, plotH = height - bottom - top
  const step = plotW / Math.max(points.length, 1)
  const barW = Math.min(24, Math.max(2, step - 2))
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${series.map(s => s.label).join(' and ')} over time` })
  for (let i = 0; i <= 4; i += 1) {
    const value = (nice / 4) * i
    const y = top + plotH - (value / nice) * plotH
    root.append(svg('line', { class: 'grid-line', x1: left, x2: width, y1: y, y2: y }))
    const text = svg('text', { class: 'axis', x: left - 8, y: y + 4, 'text-anchor': 'end' })
    text.textContent = value >= 10000 ? compact.format(value) : full.format(value)
    root.append(text)
  }
  const tooltip = el('div', { class: 'tooltip', hidden: true })
  const labelEvery = Math.ceil(points.length / 8)
  points.forEach((p, i) => {
    const x = left + i * step + (step - barW) / 2
    let base = top + plotH
    const hit = svg('rect', { class: 'hit', x: left + i * step, y: top, width: step, height: plotH, tabindex: 0 })
    root.append(hit)
    series.forEach((s, si) => {
      const value = s.value(p)
      if (!value) return
      const h = Math.max(1, (value / nice) * plotH - (si > 0 ? 2 : 0))
      const y = base - h
      // rounded data-end, square baseline: path with top corners only
      const r = Math.min(4, barW / 2, h)
      const d = `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${base} Z`
      root.append(svg('path', { class: `bar ${s.cls ?? ''}`, d }))
      base = y - 2 // 2px surface gap between stacked segments
    })
    const show = () => {
      tooltip.replaceChildren(el('div', { class: 'muted' }, label(p.t)), ...series.map(s => {
        const key = el('span', { class: 'key' }); key.style.background = s.cls === 'failed' ? 'var(--critical)' : 'var(--series-1)'
        return el('div', {}, el('strong', {}, full.format(s.value(p))), key, s.label)
      }))
      tooltip.hidden = false
      const box = wrap.getBoundingClientRect()
      const px = ((left + i * step + step / 2) / width) * box.width
      tooltip.style.left = `${Math.min(Math.max(0, px - 60), box.width - 140)}px`
      tooltip.style.top = '0px'
    }
    hit.addEventListener('pointerenter', show)
    hit.addEventListener('focus', show)
    hit.addEventListener('pointerleave', () => { tooltip.hidden = true })
    hit.addEventListener('blur', () => { tooltip.hidden = true })
    if (i % labelEvery === 0) {
      const text = svg('text', { class: 'axis', x: left + i * step + step / 2, y: height - 4, 'text-anchor': 'middle' })
      text.textContent = label(p.t, true)
      root.append(text)
    }
  })
  wrap.append(root, tooltip)
  return el('div', {}, header, wrap)
}

function niceMax(value) {
  const exp = Math.pow(10, Math.floor(Math.log10(value)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= value) return m * exp
  return 10 * exp
}

function bucketLabel(t, short) {
  const d = new Date(t)
  if (state.range === '1h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (state.range === '24h') return short ? d.toLocaleTimeString([], { hour: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(state.range === '7d' && !short ? { hour: '2-digit' } : {}) })
}

// ---------------------------------------------------------------------------
// sections

function render() {
  const o = state.overview
  const healthyEngines = o.engines.filter(e => e.healthy).length
  const openIncidents = state.incidents.filter(i => !i.resolved_ts)
  if (!healthyEngines) setHealth('critical', 'Down: no engine answering')
  else if (healthyEngines < o.engines.length || openIncidents.some(i => i.severity === 'critical')) setHealth('serious', 'Degraded')
  else if (openIncidents.length) setHealth('warning', `${openIncidents.length} open issue${openIncidents.length > 1 ? 's' : ''}`)
  else setHealth('good', 'All systems normal')

  const points = state.series.points
  const rangeTokens = points.reduce((s, p) => s + p.tokens, 0)
  const rangeRequests = points.reduce((s, p) => s + p.requests, 0)
  const rangeErrors = points.reduce((s, p) => s + p.errors, 0)
  const tps = o.engines.reduce((s, e) => s + (e.metrics?.generationTps ?? 0), 0)

  app.replaceChildren(
    el('div', { class: 'filters' },
      el('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' }, Object.entries(RANGES).map(([key, text]) =>
        el('button', { type: 'button', 'aria-pressed': state.range === key, onclick: () => { state.range = key; refresh() } }, text))),
      el('span', { class: 'meta' }, `Up ${dur(Math.round((Date.now() - o.startedAt) / 1000))} · v${o.version} · ${num(o.totals.allTime)} tokens served all time`)),
    el('section', { class: 'grid kpis' },
      tile('Tokens', num(rangeTokens), RANGES[state.range]),
      tile('Requests', num(rangeRequests), `${num(rangeErrors)} failed · ${num(o.totals.day.limited)} limited (24h)`),
      tile('Error rate', rangeRequests ? `${((rangeErrors / rangeRequests) * 100).toFixed(1)}%` : '0%', RANGES[state.range]),
      tile('Machines', num(o.clients.active24h), `active in 24h · ${num(o.clients.total)} total${o.clients.blocked ? ` · ${o.clients.blocked} blocked` : ''}`),
      tile('Latency', ms(o.latency.p50), `p50 · p95 ${ms(o.latency.p95)} · first token ${ms(o.latency.ttftP50)}`),
      tile('Throughput', `${num(tps)} tok/s`, `${o.inflight} in flight / ${o.maxInflight} max`)),
    el('section', { class: 'grid two' },
      el('div', { class: 'card' }, el('h2', {}, 'Tokens'), el('p', { class: 'sub' }, `Prompt + completion · ${RANGES[state.range]}`),
        columnChart('tokens', points, [{ label: 'Tokens', value: p => p.tokens }], bucketLabel)),
      el('div', { class: 'card' }, el('h2', {}, 'Requests'), el('p', { class: 'sub' }, `Successful and failed (5xx) · ${RANGES[state.range]}`),
        columnChart('requests', points, [{ label: 'Successful', value: p => p.requests - p.errors }, { label: 'Failed', cls: 'failed', value: p => p.errors }], bucketLabel))),
    engines(o),
    el('section', { class: 'grid two' }, machine(o), incidents()),
    clients(),
    el('section', { class: 'grid two' }, models(o), errors()),
    logs(),
  )
}

function engines(o) {
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', {}, 'Model engines'), el('span', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', onclick: async () => { await api('/engines/check', { method: 'POST' }); refresh() } }, 'Check now')),
    el('p', { class: 'sub' }, 'vLLM / llama.cpp servers behind the gateway, from their own metrics'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Status', 'Engine', 'Models', 'Running', 'Waiting', 'KV cache', 'Generation', 'In flight', 'Served', 'Since'].map((h, i) => el('th', { class: i >= 3 && i <= 8 ? 'num' : undefined }, h)))),
      el('tbody', {}, o.engines.map(e => el('tr', {},
        el('td', {}, el('span', { class: `status ${e.healthy ? 'good' : 'critical'}` }, e.healthy ? 'Healthy' : 'Down'), !e.healthy && e.lastError ? el('div', { class: 'muted mono' }, e.lastError) : null),
        el('td', {}, el('div', {}, e.kind), el('div', { class: 'muted mono' }, e.url)),
        el('td', {}, e.models.length ? e.models.join(', ') : '–'),
        el('td', { class: 'num' }, num(e.metrics?.running)),
        el('td', { class: 'num' }, num(e.metrics?.waiting)),
        el('td', { class: 'num' }, e.metrics?.kvCacheUsage === null || e.metrics?.kvCacheUsage === undefined ? '–' : `${Math.round(e.metrics.kvCacheUsage * 100)}%`),
        el('td', { class: 'num' }, e.metrics?.generationTps === null || e.metrics?.generationTps === undefined ? '–' : `${num(e.metrics.generationTps)} tok/s`),
        el('td', { class: 'num' }, num(e.inflight)),
        el('td', { class: 'num' }, num(e.served)),
        el('td', {}, ago(e.since))))))))
}

function machine(o) {
  const m = o.machine
  if (!m) return el('div', { class: 'card' }, el('h2', {}, 'Machine'), el('p', { class: 'empty' }, 'Collecting…'))
  return el('div', { class: 'card' },
    el('h2', {}, 'Machine'),
    el('p', { class: 'sub' }, `${m.hostname} · ${m.platform} · ${m.cpus} × ${m.cpuModel} · up ${dur(m.uptimeSec)}`),
    el('div', { class: 'meters' },
      meter('CPU load (1 min)', m.load[0], m.cpus, `${m.load[0].toFixed(2)} / ${m.cpus} cores`),
      meter('Memory', m.memory.totalBytes - m.memory.freeBytes, m.memory.totalBytes, `${bytes(m.memory.totalBytes - m.memory.freeBytes)} / ${bytes(m.memory.totalBytes)}`),
      ...m.disks.map(d => meter(`Disk ${d.path}`, d.totalBytes - d.freeBytes, d.totalBytes, `${bytes(d.freeBytes)} free of ${bytes(d.totalBytes)}`)),
      ...(m.gpus.length ? m.gpus.flatMap(g => [
        meter(`GPU ${g.index} · ${g.name}`, g.utilization, 100, `${g.utilization}% busy${g.temperature !== null ? ` · ${g.temperature} °C` : ''}${g.powerW !== null ? ` · ${Math.round(g.powerW)} W` : ''}`),
        meter(`GPU ${g.index} memory`, g.memoryUsedMb, g.memoryTotalMb, `${bytes(g.memoryUsedMb * 1048576)} / ${bytes(g.memoryTotalMb * 1048576)}`),
      ]) : [el('div', { class: 'muted' }, m.gpuError ?? 'No GPU reported')]),
      el('div', { class: 'muted' }, `Gateway: pid ${m.gateway.pid} · ${bytes(m.gateway.rssBytes)} RSS · Node ${m.gateway.node} · up ${dur(m.gateway.uptimeSec)}`)))
}

function incidents() {
  const open = state.incidents.filter(i => !i.resolved_ts)
  const resolved = state.incidents.filter(i => i.resolved_ts)
  const rows = (list) => list.map(i => el('tr', {},
    el('td', {}, el('span', { class: `status ${i.resolved_ts ? 'muted' : statusOf(i.severity)}` }, i.resolved_ts ? 'Resolved' : i.severity === 'critical' ? 'Critical' : i.severity === 'warning' ? 'Warning' : 'Info')),
    el('td', {}, el('div', {}, i.message), el('div', { class: 'muted' }, `${i.count > 1 ? `${i.count}× · ` : ''}first ${ago(i.first_ts)} · last ${ago(i.last_ts)}`)),
    el('td', {}, i.resolved_ts ? el('span', { class: 'muted' }, ago(i.resolved_ts)) : el('button', { class: 'btn', type: 'button', onclick: async () => { await api(`/incidents/${i.id}/resolve`, { method: 'POST' }); refresh() } }, 'Resolve'))))
  return el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', {}, 'Issues'), el('span', { class: 'spacer' }),
      resolved.length ? el('button', { class: 'btn', type: 'button', onclick: () => { state.showResolved = !state.showResolved; render() } }, state.showResolved ? 'Hide resolved' : `Show resolved (${resolved.length})`) : null),
    el('p', { class: 'sub' }, 'Engine outages, error bursts, low disk or memory, GPU limits, gateway crashes'),
    open.length || state.showResolved
      ? el('div', { class: 'table-wrap' }, el('table', {}, el('tbody', {}, rows(open), state.showResolved ? rows(resolved) : [])))
      : el('p', { class: 'empty' }, el('span', { class: 'status good' }, 'No open issues')))
}

function clients() {
  const plans = Object.keys(state.overview.plans.plans)
  return el('section', { class: 'card' },
    el('h2', {}, 'Machines'),
    el('p', { class: 'sub' }, 'Each pharo-agent install, identified by a hashed machine fingerprint. Click a row for details.'),
    state.clients.length ? el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Machine', 'Status', 'Plan', 'Session', 'Week', 'Requests 24h', 'Errors 24h', 'Last seen', ''].map((h, i) => el('th', { class: i === 5 || i === 6 ? 'num' : undefined }, h)))),
      el('tbody', {}, state.clients.map(c => el('tr', { class: 'clickable', onclick: event => { if (!event.target.closest('button, select')) openClient(c.id) } },
        el('td', {}, el('div', { class: 'mono' }, c.id), el('div', { class: 'muted' }, [c.os, c.client_version && `v${c.client_version}`, c.ip].filter(Boolean).join(' · '))),
        el('td', {}, el('span', { class: `status ${c.status === 'blocked' ? 'critical' : 'good'}` }, c.status === 'blocked' ? 'Blocked' : 'Active')),
        el('td', {}, planSelect(c, plans)),
        el('td', {}, el('div', { class: 'mini-meters' }, meter(c.usage.session.active ? `resets ${ago(c.usage.session.resetsAt)}` : 'idle', c.usage.session.used, c.usage.session.limit))),
        el('td', {}, el('div', { class: 'mini-meters' }, meter('7 days', c.usage.week.used, c.usage.week.limit))),
        el('td', { class: 'num' }, num(c.requests_24h)),
        el('td', { class: 'num' }, num(c.errors_24h)),
        el('td', {}, ago(c.last_seen)),
        el('td', {}, el('div', { class: 'filters' },
          el('button', { class: `btn ${c.status === 'blocked' ? '' : 'danger'}`, type: 'button', onclick: () => updateClient(c.id, { status: c.status === 'blocked' ? 'active' : 'blocked' }) }, c.status === 'blocked' ? 'Unblock' : 'Block'),
          el('button', { class: 'btn', type: 'button', onclick: () => confirm(`Reset the usage counters of ${c.id}?`) && updateClient(c.id, { resetUsage: true }) }, 'Reset usage')))))))) : el('p', { class: 'empty' }, 'No machine has registered yet.'))
}

function planSelect(c, plans) {
  const select = el('select', { 'aria-label': `Plan of ${c.id}`, onchange: () => updateClient(c.id, { plan: select.value }) }, plans.map(p => el('option', { value: p, selected: p === c.plan }, state.overview.plans.plans[p].label)))
  return select
}

async function updateClient(id, changes) {
  try {
    await api(`/clients/${id}`, { method: 'PATCH', body: JSON.stringify(changes) })
  } catch (error) {
    alert(error.message)
  }
  refresh()
}

async function openClient(id) {
  const detail = await api(`/clients/${id}`)
  const dialog = el('dialog', { onclose: () => dialog.remove() })
  dialog.append(el('div', { class: 'dialog-body' },
    el('div', { class: 'card-head' }, el('h2', { class: 'mono' }, id), el('span', { class: 'spacer' }), el('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Close')),
    el('p', { class: 'sub' }, `First seen ${time(detail.client.first_seen)} · last seen ${ago(detail.client.last_seen)} · fingerprint ${detail.client.fingerprint}`),
    el('div', { class: 'meters' },
      meter(`${detail.usage.session.hours}-hour session${detail.usage.session.resetsAt ? ` · resets ${ago(detail.usage.session.resetsAt)}` : ''}`, detail.usage.session.used, detail.usage.session.limit),
      meter('Last 7 days', detail.usage.week.used, detail.usage.week.limit)),
    el('div', {}, el('h2', {}, 'Tokens, last 7 days'), columnChart(`client-${id}`, detail.series, [{ label: 'Tokens', value: p => p.tokens }], t => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit' }))),
    el('div', {}, el('h2', {}, 'Recent requests'), el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Time', 'Model', 'Status', 'Prompt', 'Completion', 'Latency', 'First token'].map((h, i) => el('th', { class: i >= 3 ? 'num' : undefined }, h)))),
      el('tbody', {}, detail.requests.map(r => el('tr', {},
        el('td', {}, time(r.ts)), el('td', {}, r.model ?? '–'),
        el('td', {}, el('span', { class: `status ${r.status === 200 ? 'good' : r.status === 429 ? 'warning' : 'critical'}` }, r.status === 200 ? '200' : `${r.status} ${r.error ?? ''}`)),
        el('td', { class: 'num' }, num(r.prompt_tokens)), el('td', { class: 'num' }, num(r.completion_tokens)),
        el('td', { class: 'num' }, ms(r.latency_ms)), el('td', { class: 'num' }, ms(r.ttft_ms))))))))))
  document.body.append(dialog)
  dialog.showModal()
}

function models(o) {
  const usage = new Map(o.modelsByUsage.map(m => [m.model, m]))
  return el('div', { class: 'card' },
    el('h2', {}, 'Models'),
    el('p', { class: 'sub' }, 'GGUF models from Hugging Face (config/models.json) · usage over 7 days'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Model', 'Files', 'Size', 'Tokens 7d'].map((h, i) => el('th', { class: i >= 2 ? 'num' : undefined }, h)))),
      el('tbody', {}, o.models.map(m => el('tr', {},
        el('td', {}, el('div', {}, m.id, m.default ? el('span', { class: 'pill' }, ' default') : null), el('div', { class: 'muted mono' }, m.repo)),
        el('td', {}, el('span', { class: `status ${m.ready ? 'good' : 'warning'}` }, m.ready ? 'Downloaded' : 'Not downloaded'), m.ready ? null : el('div', { class: 'muted' }, 'run: npm run fetch-models')),
        el('td', { class: 'num' }, bytes(m.bytes)),
        el('td', { class: 'num' }, num(usage.get(m.id)?.tokens ?? 0))))))))
}

function errors() {
  return el('div', { class: 'card' },
    el('h2', {}, 'Recent failures'),
    el('p', { class: 'sub' }, 'Requests that did not succeed: limits (429), engine errors (5xx), clients that left (499)'),
    state.errors.length ? el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Time', 'Machine', 'Status', 'Detail'].map(h => el('th', {}, h)))),
      el('tbody', {}, state.errors.slice(0, 25).map(r => el('tr', {},
        el('td', {}, time(r.ts)), el('td', { class: 'mono' }, r.client_id),
        el('td', {}, el('span', { class: `status ${r.status === 429 ? 'warning' : 'critical'}` }, String(r.status))),
        el('td', { class: 'muted' }, r.error ?? '')))))) : el('p', { class: 'empty' }, el('span', { class: 'status good' }, 'No failures')))
}

function logs() {
  return el('section', { class: 'card' },
    el('h2', {}, 'Gateway log'),
    el('p', { class: 'sub' }, 'Latest 200 lines'),
    el('div', { class: 'logs' }, state.logs.slice().reverse().map(line => {
      const { ts, level, message, ...rest } = line
      return el('div', { class: `lvl-${level}` }, `${ts ? new Date(ts).toLocaleTimeString() : ''} ${String(level ?? '').padEnd(5)} ${message ?? ''} ${Object.keys(rest).length ? JSON.stringify(rest) : ''}`)
    })))
}

// ---------------------------------------------------------------------------

document.getElementById('pause').addEventListener('click', event => {
  state.paused = !state.paused
  event.target.textContent = state.paused ? 'Resume' : 'Pause'
  if (!state.paused) refresh()
})
document.getElementById('theme').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  document.documentElement.dataset.theme = current === 'dark' ? 'light' : 'dark'
  localStorage.setItem('pharo-cloud-theme', document.documentElement.dataset.theme)
})
const savedTheme = localStorage.getItem('pharo-cloud-theme')
if (savedTheme) document.documentElement.dataset.theme = savedTheme
refresh()
setInterval(refresh, 5000)
