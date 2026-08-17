import crypto from 'node:crypto'

/** Deterministic JSON serialization: object keys sort, array order stays meaningful. */
export function stableStringify(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value !== 'object') throw new TypeError('Value is not JSON-serializable')
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const object = value as Record<string, unknown>
  const members = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
  return `{${members.join(',')}}`
}

export function checksumJson(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex')
}
