/**
 * JSON-RPC framing and Streamable HTTP envelope rules for the MCP endpoint.
 *
 * Two protocol eras have to work at once. Revision `2026-07-28` removed
 * protocol-level sessions and the GET stream, and moved per-request metadata
 * into the body, so a modern client can POST `tools/call` with no handshake at
 * all. Every client shipping today still opens with `initialize` and expects a
 * negotiated version back. Refusing either one would make the endpoint useless
 * to half its callers, so this module speaks both and keys the strict checks
 * off the version the caller actually declared.
 *
 * Responses are always `application/json`. Both eras permit it for a request
 * that has nothing to stream, and every tool here returns a single value, so
 * an SSE encoder would be machinery with no purpose.
 */

/** Newest first. The head is what an unversioned or unknown request negotiates to. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
] as const

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number]

export const LATEST_PROTOCOL_VERSION: ProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS[0]

/**
 * The first revision that mirrors body fields into headers and requires them to
 * agree. Older callers never send `Mcp-Method`, so validating them against it
 * would reject every compliant legacy client.
 */
const HEADER_VALIDATION_FROM: ProtocolVersion = '2026-07-28'

export const JSON_RPC_VERSION = '2.0'

export const JsonRpcErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Streamable HTTP: headers disagree with the body, or a required one is missing. */
  headerMismatch: -32020,
} as const

export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  jsonrpc: typeof JSON_RPC_VERSION
  id?: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcSuccessResponse {
  jsonrpc: typeof JSON_RPC_VERSION
  id: JsonRpcId
  result: unknown
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSON_RPC_VERSION
  id: JsonRpcId
  error: JsonRpcError
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result }
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error: data === undefined ? { code, message } : { code, message, data } }
}

export function isSupportedProtocolVersion(value: string): value is ProtocolVersion {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value)
}

function requiresHeaderValidation(version: ProtocolVersion): boolean {
  // Dated versions compare correctly as strings; they are all `YYYY-MM-DD`.
  return version >= HEADER_VALIDATION_FROM
}

/** A parsed, envelope-valid POST body plus the metadata the transport carries. */
export interface ParsedMcpRequest {
  message: JsonRpcRequest
  /** Absent `id` means a notification, which is answered with 202 and no body. */
  isNotification: boolean
  protocolVersion: ProtocolVersion
}

export type McpRequestParseResult =
  | { ok: true; request: ParsedMcpRequest }
  | { ok: false; status: number; response: JsonRpcErrorResponse }

function readMetaProtocolVersion(params: Record<string, unknown> | undefined): string | null {
  const meta = params?._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const value = (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion']
  return typeof value === 'string' ? value : null
}

/**
 * Undo the `=?base64?…?=` sentinel a client uses for a header value that cannot
 * be written as plain ASCII. Comparing the raw sentinel against the body would
 * report a mismatch on every non-ASCII tool name.
 */
function decodeHeaderValue(value: string): string {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value
  try {
    const encoded = value.slice('=?base64?'.length, -'?='.length)
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)))
  } catch {
    return value
  }
}

/**
 * Validate the HTTP envelope and JSON-RPC shape of one POST.
 *
 * Returns the negotiated protocol version alongside the message so the
 * dispatcher never has to re-derive it. A failure carries both the HTTP status
 * and the JSON-RPC body, because Streamable HTTP pairs specific statuses with
 * specific error codes and a caller distinguishes eras by reading them.
 */
export function parseMcpRequest(headers: Headers, body: unknown): McpRequestParseResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      response: jsonRpcError(null, JsonRpcErrorCodes.invalidRequest, 'Request body must be a JSON-RPC object.'),
    }
  }

  const message = body as Record<string, unknown>
  if (message.jsonrpc !== JSON_RPC_VERSION) {
    return {
      ok: false,
      status: 400,
      response: jsonRpcError(null, JsonRpcErrorCodes.invalidRequest, 'Expected "jsonrpc": "2.0".'),
    }
  }
  if (typeof message.method !== 'string' || message.method.length === 0) {
    return {
      ok: false,
      status: 400,
      response: jsonRpcError(null, JsonRpcErrorCodes.invalidRequest, 'Request is missing a "method".'),
    }
  }
  if ('result' in message || 'error' in message) {
    // Clients never send responses on this transport in any era.
    return {
      ok: false,
      status: 400,
      response: jsonRpcError(null, JsonRpcErrorCodes.invalidRequest, 'Clients must not send JSON-RPC responses.'),
    }
  }

  const rawId = message.id
  const isNotification = rawId === undefined
  const id: JsonRpcId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null
  const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params)
    ? message.params as Record<string, unknown>
    : undefined

  const headerVersion = headers.get('mcp-protocol-version')?.trim() || null
  const bodyVersion = readMetaProtocolVersion(params)

  // A version present in both places must agree before either is trusted; a
  // proxy routing on the header and a server reading the body would otherwise
  // act on different values.
  if (headerVersion && bodyVersion && headerVersion !== bodyVersion) {
    return {
      ok: false,
      status: 400,
      response: jsonRpcError(
        id,
        JsonRpcErrorCodes.headerMismatch,
        `MCP-Protocol-Version header "${headerVersion}" does not match the body value "${bodyVersion}".`,
      ),
    }
  }

  const declared = headerVersion ?? bodyVersion

  // An `initialize` with no declared version is a legacy client opening a
  // handshake; it negotiates inside the method. Anything else defaults to the
  // newest version, which is also the one whose rules are strictest.
  let protocolVersion: ProtocolVersion = LATEST_PROTOCOL_VERSION
  if (declared !== null) {
    if (!isSupportedProtocolVersion(declared)) {
      return {
        ok: false,
        status: 400,
        response: jsonRpcError(
          id,
          JsonRpcErrorCodes.invalidRequest,
          `Unsupported protocol version "${declared}".`,
          { supported: [...SUPPORTED_PROTOCOL_VERSIONS] },
        ),
      }
    }
    protocolVersion = declared
  }

  if (declared !== null && requiresHeaderValidation(protocolVersion)) {
    const mismatch = validateMirroredHeaders(headers, message.method, params)
    if (mismatch) {
      return { ok: false, status: 400, response: jsonRpcError(id, JsonRpcErrorCodes.headerMismatch, mismatch) }
    }
  }

  return {
    ok: true,
    request: {
      message: { jsonrpc: JSON_RPC_VERSION, id, method: message.method, params },
      isNotification,
      protocolVersion,
    },
  }
}

/** `Mcp-Method` and, where the method carries a name, `Mcp-Name` must mirror the body. */
function validateMirroredHeaders(
  headers: Headers,
  method: string,
  params: Record<string, unknown> | undefined,
): string | null {
  const headerMethod = headers.get('mcp-method')?.trim()
  if (!headerMethod) return 'Mcp-Method header is required.'
  if (headerMethod !== method) {
    return `Mcp-Method header "${headerMethod}" does not match the body method "${method}".`
  }

  const namedMethods: Record<string, 'name' | 'uri'> = {
    'tools/call': 'name',
    'resources/read': 'uri',
    'prompts/get': 'name',
  }
  const nameField = namedMethods[method]
  if (!nameField) return null

  const bodyValue = params?.[nameField]
  if (typeof bodyValue !== 'string') return null

  const headerName = headers.get('mcp-name')
  if (headerName === null) return 'Mcp-Name header is required for this method.'
  const decoded = decodeHeaderValue(headerName.trim())
  if (decoded !== bodyValue) {
    return `Mcp-Name header "${decoded}" does not match the body value "${bodyValue}".`
  }
  return null
}

/**
 * Reject a cross-origin browser caller.
 *
 * A non-browser MCP client sends no `Origin` at all, so this is only ever
 * exercised by a page in a browser. Allowing same-origin and absent covers
 * every real client while closing the DNS-rebinding hole the transport spec
 * calls out.
 */
export function isAllowedOrigin(headers: Headers, requestUrl: string): boolean {
  const origin = headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).origin === new URL(requestUrl).origin
  } catch {
    return false
  }
}
