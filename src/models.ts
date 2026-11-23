import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { CloudConfig, ModelSpec } from './config.ts'
import { log } from './log.ts'

/** Every model ends up as <modelsDir>/<id>/model.gguf: what vLLM / llama.cpp load. */
export function modelPath(config: CloudConfig, model: ModelSpec): string {
  return path.join(config.modelsDir, model.id, 'model.gguf')
}

export type ModelStatus = {
  id: string
  repo: string
  files: { name: string; bytes: number | null }[]
  ready: boolean
  path: string
  bytes: number | null
  default: boolean
}

export async function modelStatuses(config: CloudConfig): Promise<ModelStatus[]> {
  return Promise.all(config.models.map(async model => {
    const dir = path.join(config.modelsDir, model.id)
    const files = await Promise.all(model.files.map(async name => ({ name, bytes: await size(path.join(dir, name)) })))
    const final = modelPath(config, model)
    const bytes = await size(final)
    return { id: model.id, repo: model.repo, files, ready: bytes !== null && bytes > 0, path: final, bytes, default: Boolean(model.default) }
  }))
}

async function size(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size
  } catch {
    return null
  }
}

export function huggingFaceUrl(repo: string, file: string, revision = 'main'): string {
  return `https://huggingface.co/${repo}/resolve/${revision}/${file.split('/').map(encodeURIComponent).join('/')}`
}

/** Download with resume (Range) into <dest>.part, then rename. */
export async function download(url: string, dest: string, options: { token?: string; onProgress?: (received: number, total?: number) => void } = {}): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true })
  const partial = `${dest}.part`
  const have = (await size(partial)) ?? 0
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(have ? { range: `bytes=${have}-` } : {}),
    },
  })
  if (response.status === 416) {
    await rename(partial, dest)
    return
  }
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}) for ${url}`)
  const resumed = response.status === 206
  const total = Number(response.headers.get('content-length') ?? 0) + (resumed ? have : 0) || undefined
  let received = resumed ? have : 0
  const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    options.onProgress?.(received, total)
  })
  await pipeline(body, createWriteStream(partial, { flags: resumed ? 'a' : 'w' }))
  await rename(partial, dest)
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => (error ? reject(new Error(`${command} failed: ${stderr || error.message}`)) : resolve()))
  })
}

/**
 * Fetch one model: download its GGUF file(s) from Hugging Face, then produce
 * model.gguf. Split models are merged with llama.cpp's llama-gguf-split
 * because vLLM loads a single GGUF file.
 */
export async function fetchModel(config: CloudConfig, model: ModelSpec, options: { token?: string; mergeTool?: string; onProgress?: (file: string, received: number, total?: number) => void } = {}): Promise<string> {
  const dir = path.join(config.modelsDir, model.id)
  await mkdir(dir, { recursive: true })
  const final = modelPath(config, model)
  // Ready already (the shards may have been removed after merging).
  if (await size(final)) return final
  for (const file of model.files) {
    const dest = path.join(dir, file)
    if (await size(dest)) continue
    log('info', 'downloading model file', { model: model.id, repo: model.repo, file })
    await download(huggingFaceUrl(model.repo, file), dest, { token: options.token, onProgress: (received, total) => options.onProgress?.(file, received, total) })
  }
  if (model.files.length === 1) {
    await symlink(model.files[0]!, final)
  } else {
    const tool = options.mergeTool ?? 'llama-gguf-split'
    log('info', 'merging split GGUF', { model: model.id, shards: model.files.length })
    const tmp = `${final}.merging`
    await rm(tmp, { force: true })
    await run(tool, ['--merge', path.join(dir, model.files[0]!), tmp])
    await rename(tmp, final)
    // Shards are no longer needed once merged: keep the disk for the merged file.
    for (const file of model.files) await rm(path.join(dir, file), { force: true })
  }
  log('info', 'model ready', { model: model.id, path: final })
  return final
}

export async function listModelDirs(config: CloudConfig): Promise<string[]> {
  return readdir(config.modelsDir).catch(() => [])
}
