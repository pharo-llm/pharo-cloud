#!/usr/bin/env node
/** Download every model in config/models.json from Hugging Face (HF_TOKEN for private repos). */
import { loadConfig } from './config.ts'
import { fetchModel } from './models.ts'

const config = loadConfig()
const only = process.argv.slice(2)
let failed = false
for (const model of config.models.filter(entry => !only.length || only.includes(entry.id))) {
  let last = 0
  try {
    const file = await fetchModel(config, model, {
      token: process.env.HF_TOKEN,
      mergeTool: process.env.PHARO_CLOUD_MERGE_TOOL,
      onProgress: (name, received, total) => {
        if (Date.now() - last < 2_000) return
        last = Date.now()
        process.stdout.write(`  ${model.id} ${name}: ${(received / 1e9).toFixed(2)}${total ? ` / ${(total / 1e9).toFixed(2)}` : ''} GB\n`)
      },
    })
    process.stdout.write(`✓ ${model.id} ready: ${file}\n`)
  } catch (error) {
    failed = true
    process.stderr.write(`✗ ${model.id}: ${(error as Error).message}\n`)
  }
}
process.exit(failed ? 1 : 0)
