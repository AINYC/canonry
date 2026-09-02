/** Convert a bind-only wildcard into a loopback host an operator can open. */
export function operatorHost(bindHost: string): string {
  return bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost
}

export function operatorHttpUrl(bindHost: string, port: string | number): string {
  return `http://${operatorHost(bindHost)}:${port}`
}
