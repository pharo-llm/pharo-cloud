import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

export class HttpError extends Error {
  readonly status: number
  readonly type: string
  constructor(status: number, type: string, message: string) {
    super(message)
    this.status = status
    this.type = type
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

/** Errors in the OpenAI shape clients already understand, with our extra fields. */
export function sendError(res: ServerResponse, status: number, type: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { message, type, code: type, ...extra } }, headers)
}

export async function readJson(req: IncomingMessage, maxBytes = 20 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new HttpError(413, 'request_too_large', `Request body is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`)
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object')
  }
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim()
    if (forwarded) return forwarded
  }
  return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '')
}

export function isLoopback(req: IncomingMessage): boolean {
  const address = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
  return address === '127.0.0.1' || address === '::1'
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
