import type { FastifyInstance } from 'fastify'

/**
 * Close a Fastify app without letting keep-alive connections hold it open.
 *
 * Fastify 5 (forceCloseConnections "idle") calls server.closeIdleConnections()
 * exactly once, when close() starts, and then waits for server.close(). Node's
 * http server (through v24) does not re-check when a response finishes: a
 * connection that was mid-request at that moment delivers its response, is
 * marked keep-alive and re-armed for keepAliveTimeout (72 s), and server.close()
 * keeps waiting for it. In the daemon that is the engine's own traffic-sync
 * self-request or a reverse proxy's pooled upstream connection, so a restart
 * that catches one of those ends in the supervisor's SIGKILL with the onClose
 * hooks (scheduler.stop) never run. Sweeping idle connections on a short
 * interval while close() is pending drops each connection the moment its
 * response is done, and close() resolves right after the last in-flight
 * request.
 */
export async function closeWithIdleSweep(app: FastifyInstance, intervalMs = 250): Promise<void> {
  const sweep = setInterval(() => app.server.closeIdleConnections(), intervalMs)
  sweep.unref()
  try {
    await app.close()
  } finally {
    clearInterval(sweep)
  }
}
