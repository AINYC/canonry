import crypto from 'node:crypto'

import { isReadOnlyKey } from '@ainyc/canonry-contracts'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { ApiClient } from './client.js'
import { createCanonryMcpServer } from './mcp/server.js'

/**
 * MCP over Streamable HTTP.
 *
 * The stdio adapter puts one server in one process for one user, so identity
 * and lifetime come free. Over HTTP neither does, and the two facts that shape
 * everything here are:
 *
 * 1. The dynamic tool catalog is PER SERVER INSTANCE — enabling a toolkit
 *    mutates it. One shared server would leak one caller's tool state into
 *    every other caller's session, so there is one McpServer and one transport
 *    per session, and a session is pinned to the key that created it.
 * 2. Nothing reaps an HTTP session. A client that goes away without DELETE
 *    leaves its server behind forever, so the idle sweep below is not a
 *    refinement — without it the process leaks until it dies.
 *
 * Mounted through `registerAuthenticatedRoutes`, so it lands INSIDE the
 * api-routes plugin scope and the auth hook actually runs. Registering it on
 * the root app instead would serve MCP with no authentication at all; that is
 * not theoretical, it is what a test doing exactly that produced.
 */

/** Idle sessions are dropped after this long without a request. */
const SESSION_IDLE_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 1000

interface McpSession {
  transport: StreamableHTTPServerTransport
  close: () => Promise<void>
  /** The api key id that created this session. A different key may not reuse it. */
  keyId: string
  lastSeenAt: number
}

export interface McpHttpOptions {
  /** Base URL the per-session client calls back on — loopback, not the public host. */
  selfApiUrl: string
  /** Overridable for tests. */
  now?: () => number
}

export function registerMcpHttpRoutes(scope: FastifyInstance, opts: McpHttpOptions): void {
  const sessions = new Map<string, McpSession>()
  const now = opts.now ?? (() => Date.now())

  async function dropSession(id: string): Promise<void> {
    const session = sessions.get(id)
    if (!session) return
    sessions.delete(id)
    await session.close().catch(() => {
      // A transport that already tore itself down is the normal case here.
    })
  }

  const sweep = setInterval(() => {
    const cutoff = now() - SESSION_IDLE_MS
    for (const [id, session] of sessions) {
      if (session.lastSeenAt < cutoff) void dropSession(id)
    }
  }, SWEEP_INTERVAL_MS)
  // Never hold the process open for a housekeeping timer.
  sweep.unref()

  scope.addHook('onClose', async () => {
    clearInterval(sweep)
    await Promise.all([...sessions.keys()].map(id => dropSession(id)))
  })

  /**
   * The caller's OWN bearer, taken from the header rather than from
   * `request.apiKey` — auth stores only the hash, and the instance's default
   * key carries scopes ['*']. Reusing that key here would silently upgrade a
   * read-only caller to full write access on every tool call.
   */
  function callerBearer(request: FastifyRequest): string | null {
    const header = request.headers.authorization
    if (typeof header !== 'string') return null
    // Parsed with string ops rather than a regex: `/^Bearer\s+(.+)$/` lets the
    // quantifiers exchange characters and backtrack super-linearly, and this
    // runs on an attacker-supplied header on every request.
    const trimmed = header.trim()
    const prefix = 'bearer '
    if (trimmed.length <= prefix.length) return null
    if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix) return null
    return trimmed.slice(prefix.length).trim() || null
  }

  async function openSession(request: FastifyRequest, keyId: string): Promise<McpSession | null> {
    const bearer = callerBearer(request)
    if (!bearer) return null

    // Read-only keys get a read-only catalog. Eager, because progressive
    // discovery does not survive this transport: it announces new tools with a
    // list-changed notification, and those are dropped when the client never
    // opens the GET stream.
    const scopes = request.principal?.scopes ?? request.apiKey?.scopes ?? []
    const client = new ApiClient(opts.selfApiUrl, bearer, { skipProbe: true })
    const server = createCanonryMcpServer({
      scope: isReadOnlyKey(scopes) ? 'read-only' : 'all',
      eager: true,
      clientFactory: () => client,
    })

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, close, keyId, lastSeenAt: now() })
      },
    })

    async function close(): Promise<void> {
      await transport.close()
      await server.close()
    }

    transport.onclose = () => {
      const id = transport.sessionId
      if (id) sessions.delete(id)
    }

    await server.connect(transport)
    return { transport, close, keyId, lastSeenAt: now() }
  }

  async function handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const keyId = request.principal?.id ?? request.apiKey?.id
    if (!keyId) {
      await reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' } })
      return
    }

    const sessionId = request.headers['mcp-session-id']
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined

    if (existing) {
      // A session belongs to the credential that opened it. Without this a
      // leaked session id would let any authenticated caller ride another
      // caller's server — including its tool scope.
      if (existing.keyId !== keyId) {
        await reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown MCP session.' } })
        return
      }
      existing.lastSeenAt = now()
      await existing.transport.handleRequest(request.raw, reply.raw, request.body)
      return
    }

    if (typeof sessionId === 'string') {
      // Named a session we do not have: expired, reaped, or from another
      // process. 404 is what tells a client to re-initialize.
      await reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown MCP session.' } })
      return
    }

    const opened = await openSession(request, keyId)
    if (!opened) {
      await reply.status(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' } })
      return
    }
    await opened.transport.handleRequest(request.raw, reply.raw, request.body)
  }

  // `transportEnvelope` exempts the JSON-RPC envelope from the method-based
  // read-only gate — a read is carried inside a POST here. It admits the
  // envelope only: every tool call re-enters the API as a fresh authenticated
  // request carrying this same bearer, so the read-only, ads and project gates
  // all re-apply per operation.
  const config = { transportEnvelope: true } as const
  scope.post('/mcp', { config }, handle)
  scope.get('/mcp', { config }, handle)
  scope.delete('/mcp', { config }, handle)
}
