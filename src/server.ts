#!/usr/bin/env node
import { loadConfig, VERSION } from './config.ts'
import { createApp } from './app.ts'
import { log } from './log.ts'

const config = loadConfig()
const app = createApp(config)

process.on('unhandledRejection', reason => {
  log('error', 'unhandled rejection', { error: String((reason as Error)?.stack ?? reason) })
  app.store.raise('gateway_rejection', 'warning', `Unhandled promise rejection: ${String((reason as Error)?.message ?? reason)}`, {}, Date.now())
})
process.on('uncaughtException', error => {
  // Record it where the admin will see it, then let the supervisor restart us.
  log('error', 'gateway crashed', { error: error.stack })
  try {
    app.store.raise('gateway_crash', 'critical', `Gateway crashed: ${error.message}`, { stack: error.stack }, Date.now())
  } finally {
    process.exit(1)
  }
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('info', 'shutting down', { signal })
    void app.close().finally(() => process.exit(0))
  })
}

app.server.listen(config.port, config.host, () => {
  log('info', 'pharo-cloud gateway listening', {
    version: VERSION,
    url: `http://${config.host}:${config.port}`,
    engines: config.upstreams,
    models: config.models.map(model => model.id),
    admin: config.adminToken ? 'token or loopback' : 'loopback only',
  })
})
