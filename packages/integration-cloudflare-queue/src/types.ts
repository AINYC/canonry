/** A fetch implementation is injected so callers and tests control I/O. */
export type CloudflareQueueFetch = typeof fetch

export interface CloudflareQueueClientOptions {
  accountId: string
  queueId: string
  /** Kept in the caller's credential store. Never returned or logged here. */
  apiToken: string
  fetchImpl?: CloudflareQueueFetch
  apiBaseUrl?: string
  timeoutMs?: number
  maxRetries?: number
  retryBaseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface PullCloudflareQueueMessagesOptions {
  batchSize?: number
  visibilityTimeoutMs?: number
  signal?: AbortSignal
}

export interface CloudflareQueueMessageBase {
  id: string
  timestampMs: number
  attempts: number
  leaseId: string
  metadata: Readonly<Record<string, string>>
}

/** JSON payloads are decoded from Cloudflare's base64 wire envelope and parsed. */
export interface CloudflareQueueJsonMessage extends CloudflareQueueMessageBase {
  contentType: 'json'
  body: unknown
}

/** Text payloads are already plain UTF-8 in Cloudflare's pull response. */
export interface CloudflareQueueTextMessage extends CloudflareQueueMessageBase {
  contentType: 'text'
  body: string
}

/** Bytes are decoded from Cloudflare's base64 wire envelope, not parsed. */
export interface CloudflareQueueBytesMessage extends CloudflareQueueMessageBase {
  contentType: 'bytes'
  body: Uint8Array
}

/** Safe per-message rejection. It preserves the lease needed to ACK/drop it, never its raw body. */
export interface CloudflareQueuePoisonMessage extends CloudflareQueueMessageBase {
  contentType: 'poison'
  reason: 'malformed-envelope' | 'malformed-body' | 'unsupported-content-type'
}

export type CloudflareQueueMessage =
  | CloudflareQueueJsonMessage
  | CloudflareQueueTextMessage
  | CloudflareQueueBytesMessage
  | CloudflareQueuePoisonMessage

export interface CloudflareQueuePullResult {
  messageBacklogCount: number
  messages: CloudflareQueueMessage[]
  /** Raw entries without a usable lease. They are excluded because they cannot be acknowledged. */
  skippedUnleasedMessageCount: number
}

export interface CloudflareQueueRetry {
  leaseId: string
  delaySeconds?: number
}

export interface AckCloudflareQueueMessagesOptions {
  acks?: readonly string[]
  retries?: readonly CloudflareQueueRetry[]
  signal?: AbortSignal
}

export interface CloudflareQueueAckResult {
  acknowledgedLeaseIds: readonly string[]
  retriedLeaseIds: readonly CloudflareQueueRetry[]
  /** Number of upstream warnings. Warning keys and messages are not exposed. */
  warningCount: number
}
