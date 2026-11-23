import { appendFileSync, mkdirSync, readFileSync, statSync, renameSync } from 'node:fs'
import path from 'node:path'

let file: string | undefined
const MAX_BYTES = 20 * 1024 * 1024

/** JSON-lines log, to stdout and to a file the admin dashboard can tail. */
export function setLogFile(target: string): void {
  mkdirSync(path.dirname(target), { recursive: true })
  file = target
}

export function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields })
  if (process.env.PHARO_CLOUD_QUIET !== '1') (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)
  if (!file) return
  try {
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, `${file}.1`)
    appendFileSync(file, `${line}\n`)
  } catch {
    // logging must never break a request
  }
}

export function tailLog(lines = 200): Record<string, unknown>[] {
  if (!file) return []
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).map(line => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return { message: line }
      }
    })
  } catch {
    return []
  }
}
