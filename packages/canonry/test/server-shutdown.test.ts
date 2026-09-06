import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import { closeWithIdleSweep } from '../src/server-shutdown.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function get(agent: http.Agent, port: number, path: string): Promise<{ status: number; keepAlive: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, agent }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, keepAlive: res.headers.connection }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function slowServer(): Promise<{ app: ReturnType<typeof Fastify>; port: number }> {
  const app = Fastify()
  app.get('/slow', async () => {
    await sleep(300)
    return { ok: true }
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  return { app, port: (app.server.address() as AddressInfo).port }
}

describe('closeWithIdleSweep', () => {
  it('resolves right after a keep-alive client finishes its in-flight request', async () => {
    const { app, port } = await slowServer()
    const agent = new http.Agent({ keepAlive: true })
    try {
      const inflight = get(agent, port, '/slow')
      await sleep(50)
      const started = Date.now()
      await closeWithIdleSweep(app, 25)
      const closeMs = Date.now() - started
      const res = await inflight
      expect(res.status).toBe(200)
      expect(res.keepAlive).toBe('keep-alive')
      expect(closeMs).toBeLessThan(2000)
    } finally {
      agent.destroy()
    }
  })

  it('documents why: a plain close() stays pending on that same connection', async () => {
    const { app, port } = await slowServer()
    const agent = new http.Agent({ keepAlive: true })
    try {
      const inflight = get(agent, port, '/slow')
      await sleep(50)
      const closed = app.close().then(() => 'closed' as const)
      const outcome = await Promise.race([closed, sleep(1500).then(() => 'pending' as const)])
      expect((await inflight).status).toBe(200)
      expect(outcome).toBe('pending')
    } finally {
      agent.destroy()
      await app.close()
    }
  })
})
