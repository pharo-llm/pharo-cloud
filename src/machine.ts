import os from 'node:os'
import { execFile } from 'node:child_process'
import { readFileSync, statfsSync } from 'node:fs'
import type { Store } from './db.ts'

export type Gpu = {
  index: number
  name: string
  utilization: number
  memoryUsedMb: number
  memoryTotalMb: number
  temperature: number | null
  powerW: number | null
}

export type Disk = { path: string; totalBytes: number; freeBytes: number }

export type MachineSnapshot = {
  hostname: string
  platform: string
  arch: string
  cpus: number
  cpuModel: string
  load: [number, number, number]
  memory: { totalBytes: number; freeBytes: number }
  uptimeSec: number
  gateway: { pid: number; rssBytes: number; uptimeSec: number; node: string }
  disks: Disk[]
  gpus: Gpu[]
  gpuError?: string
  at: number
}

/** `nvidia-smi` CSV: index, name, util %, mem used MiB, mem total MiB, temp C, power W. */
export function parseNvidiaSmi(text: string): Gpu[] {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const [index, name, util, used, total, temp, power] = line.split(',').map(part => part.trim())
    const num = (value?: string) => (value && /^[\d.]+$/.test(value) ? Number(value) : null)
    return {
      index: Number(index),
      name: name ?? 'GPU',
      utilization: num(util) ?? 0,
      memoryUsedMb: num(used) ?? 0,
      memoryTotalMb: num(total) ?? 0,
      temperature: num(temp),
      powerW: num(power),
    }
  })
}

function gpus(): Promise<{ gpus: Gpu[]; error?: string }> {
  return new Promise(resolve => {
    execFile('nvidia-smi', ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits'], { timeout: 5_000 }, (error, stdout) => {
      if (error) resolve({ gpus: [], error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'nvidia-smi not found (no NVIDIA GPU visible to the gateway)' : error.message })
      else resolve({ gpus: parseNvidiaSmi(stdout) })
    })
  })
}

function disk(target: string): Disk | undefined {
  try {
    const stats = statfsSync(target)
    return { path: target, totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize }
  } catch {
    return undefined
  }
}

/**
 * Memory the system can still hand out. os.freemem() leaves out the cache the
 * kernel frees on demand, which makes every busy server look "out of memory".
 */
function availableMemory(): Promise<number> {
  if (process.platform === 'linux') {
    try {
      const match = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'))
      if (match) return Promise.resolve(Number(match[1]) * 1024)
    } catch {
      // fall through
    }
  }
  if (process.platform === 'darwin') {
    return new Promise(resolve => {
      execFile('vm_stat', { timeout: 3_000 }, (error, stdout) => {
        if (error) return resolve(os.freemem())
        const page = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 4096)
        const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0)
        resolve((pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * page)
      })
    })
  }
  return Promise.resolve(os.freemem())
}

const started = Date.now()

export async function snapshot(paths: string[]): Promise<MachineSnapshot> {
  const [gpu, available] = await Promise.all([gpus(), availableMemory()])
  const cpus = os.cpus()
  const seen = new Set<string>()
  const disks = paths.map(disk).filter((entry): entry is Disk => {
    if (!entry) return false
    const key = `${entry.totalBytes}:${entry.freeBytes}`
    if (seen.has(key)) return false // same filesystem
    seen.add(key)
    return true
  })
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpus: cpus.length,
    cpuModel: cpus[0]?.model ?? 'CPU',
    load: os.loadavg() as [number, number, number],
    memory: { totalBytes: os.totalmem(), freeBytes: available },
    uptimeSec: Math.round(os.uptime()),
    gateway: { pid: process.pid, rssBytes: process.memoryUsage().rss, uptimeSec: Math.round((Date.now() - started) / 1_000), node: process.version },
    disks,
    gpus: gpu.gpus,
    gpuError: gpu.error,
    at: Date.now(),
  }
}

/** Turn machine readings into incidents (opened once, resolved when back to normal). */
export function checkMachine(store: Store, machine: MachineSnapshot): void {
  const now = machine.at
  for (const entry of machine.disks) {
    const free = entry.freeBytes / entry.totalBytes
    const kind = `disk_low:${entry.path}`
    if (free < 0.05) store.raise(kind, 'critical', `Disk almost full at ${entry.path}: ${(free * 100).toFixed(1)}% free`, entry, now)
    else if (free < 0.1) store.raise(kind, 'warning', `Disk space low at ${entry.path}: ${(free * 100).toFixed(1)}% free`, entry, now)
    else store.resolve(kind, now)
  }
  const memoryFree = machine.memory.freeBytes / machine.memory.totalBytes
  if (memoryFree < 0.05) store.raise('memory_low', 'warning', `System memory almost exhausted: ${(memoryFree * 100).toFixed(1)}% free`, machine.memory, now)
  else store.resolve('memory_low', now)
  for (const gpu of machine.gpus) {
    const memory = gpu.memoryTotalMb ? gpu.memoryUsedMb / gpu.memoryTotalMb : 0
    if (memory > 0.98) store.raise(`gpu_memory:${gpu.index}`, 'warning', `GPU ${gpu.index} memory is full (${Math.round(memory * 100)}%)`, gpu, now)
    else store.resolve(`gpu_memory:${gpu.index}`, now)
    if (gpu.temperature !== null && gpu.temperature >= 87) store.raise(`gpu_hot:${gpu.index}`, 'warning', `GPU ${gpu.index} is hot: ${gpu.temperature} °C`, gpu, now)
    else store.resolve(`gpu_hot:${gpu.index}`, now)
  }
}
