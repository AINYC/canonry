/**
 * Canonry's deterministic JSON encoding for Cloudflare edge-event batches.
 *
 * It deliberately accepts only JSON values, sorts every object key using
 * JavaScript's stable UTF-16 lexical order, and otherwise uses the platform's
 * JSON scalar encoding. The generated Worker embeds this exact function and
 * the receiver calls it before HMAC verification, so property insertion order
 * cannot change the signature.
 */
export function canonicalizeCloudflareJson(value: unknown): string {
  if (value === null) return 'null'

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Cloudflare canonical JSON does not support non-finite numbers')
    }
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalizeCloudflareJson(item)).join(',')}]`
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const fields: string[] = []
    for (const key of Object.keys(record).sort()) {
      const fieldValue = record[key]
      if (fieldValue === undefined) continue
      fields.push(`${JSON.stringify(key)}:${canonicalizeCloudflareJson(fieldValue)}`)
    }
    return `{${fields.join(',')}}`
  }

  throw new TypeError(`Cloudflare canonical JSON does not support ${typeof value}`)
}
