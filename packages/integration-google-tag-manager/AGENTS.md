# integration-google-tag-manager

## Purpose

Read-only Google Tag Manager integration for account/container/workspace discovery and sanitized evidence snapshots used by Canonry's conversion-integrity workflow.

OAuth token storage and project configuration live outside this package. The client accepts an access token from its caller.

## Key Files

| File | Role |
|------|------|
| `src/client.ts` | Typed GTM discovery and workspace reads |
| `src/http.ts` | Shared GET helper with bounded retries and timeouts |
| `src/dto-adapter.ts` | Converts provider DTOs to stable internal shapes |
| `src/recognizer.ts` | Recognizes supported tags, triggers, and variables |
| `src/snapshot.ts` | Builds sanitized conversion-evidence snapshots |
| `src/checksum.ts` | Deterministic snapshot checksums |
| `src/types.ts` | Provider DTOs, normalized records, and errors |
| `src/constants.ts` | API scope, host, limits, and timeout defaults |
| `src/index.ts` | Public exports |

## Patterns

- **Read-only provider boundary** — use GET/list operations only. Do not create versions, publish containers, or mutate workspace resources.
- **Sanitized snapshots** — redact sensitive or irrelevant provider fields before persistence or API exposure.
- **Deterministic evidence** — normalize ordering before checksumming so equivalent workspaces produce the same checksum.
- **Safe unknowns** — preserve unrecognized resource kinds without interpreting or exposing unsafe raw values.
- **Bounded I/O** — retain request timeouts, list limits, pagination limits, and retry guards.

## Common Mistakes

- Persisting raw GTM API responses instead of the sanitized snapshot.
- Making checksum output depend on provider response ordering.
- Adding version or publish endpoints to a read-only integration.

## See Also

- `packages/contracts/src/google-tag-manager.ts` — shared contracts
- `packages/contracts/src/google-marketing.ts` — cross-provider conversion-integrity contracts
- `packages/integration-google-tag-manager/test/snapshot.test.ts` — snapshot sanitization tests
