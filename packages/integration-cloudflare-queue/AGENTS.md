# integration-cloudflare-queue

## Purpose

Cloudflare Queues HTTP pull and acknowledgement client. It converts the
Cloudflare wire envelope into typed messages for the traffic routes while
keeping API tokens, raw poison bodies, and transport details out of errors.
Database writes, source lifecycle, leases, and traffic normalization remain in
`packages/api-routes` and `packages/integration-traffic`.

## Key Files

| File | Role |
|------|------|
| `src/client.ts` | Injected-fetch pull/ack client, bounded retries, envelope decoding, poison handling, and acknowledgement validation. |
| `src/types.ts` | Public client options and decoded message/result types. |
| `src/index.ts` | Public exports. |
| `test/client.test.ts` | Wire-contract, retry, timeout, redaction, poison, and partial-ack regressions. |

## Patterns

- **Injected I/O.** Keep `fetch` and retry sleeping injectable so tests are
  deterministic and no test calls Cloudflare.
- **Bounded pull.** Cloudflare accepts at most 100 messages per pull and a
  visibility timeout up to 12 hours. Validate both before issuing a request.
- **Bounded retries.** A request times out after 30 seconds by default. Retry
  429 and 5xx responses at most three times, and cap each exponential or
  `Retry-After` delay at 30 seconds so the caller can stay within its source
  lease.
- **Content-aware decoding.** JSON and bytes bodies are base64-decoded; JSON is
  then parsed. Text bodies remain the plain UTF-8 strings returned by
  Cloudflare.
- **Poison is ACK-able.** If a message has a usable lease but its envelope,
  body, or content type is malformed, return a poison message without its raw
  body. Reject the whole pull when the lease is missing or invalid because the
  caller cannot safely acknowledge that message.
- **Exact acknowledgement confirmation.** Accept an ACK response only when its
  official `ackCount` and `retryCount` match the submitted leases and it has no
  warnings.
- **Secret-free failures.** Never include the bearer token, response body,
  message body, or an injected fetch error in a thrown error.

## Common Mistakes

- Parsing a `text` message as JSON or base64.
- Returning a malformed raw body with a poison message.
- Retrying an invalid request, an abort, or an upstream delay without a cap.
- Treating HTTP success as acknowledgement without validating both counts and
  warnings.
- Adding database or source-authority behavior to this transport-only package.

## See Also

- `packages/api-routes/src/traffic.ts` — source lease, drain loop,
  commit-before-ACK, backlog persistence, and lifecycle fences.
- `packages/integration-cloudflare-worker/AGENTS.md` — shared event capture and
  Queue-producer Worker generation.
- `packages/contracts/src/traffic.ts` — Queue source configuration and traffic
  DTOs.
