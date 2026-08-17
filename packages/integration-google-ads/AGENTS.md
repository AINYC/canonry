# integration-google-ads

## Purpose

Read-only Google Ads integration for account discovery, conversion-action evidence, and reporting used by Canonry's conversion-integrity workflow.

OAuth token storage and project configuration live outside this package. The client accepts an access token and developer token from its caller.

## Key Files

| File | Role |
|------|------|
| `src/google-ads-client.ts` | Typed Google Ads API client and bounded pagination |
| `src/queries.ts` | GAQL queries for customer and conversion-action reads |
| `src/goal-semantics.ts` | Normalizes provider goal state into Canonry semantics |
| `src/types.ts` | Provider DTOs, normalized records, and errors |
| `src/constants.ts` | API version, scope, limits, and timeout defaults |
| `src/index.ts` | Public exports |

## Patterns

- **Read-only provider boundary** — use discovery and reporting endpoints only. Do not add campaign, goal, or conversion-action mutations here.
- **Two credentials** — every request needs an OAuth access token and a separate Google Ads developer token. Never log or include either in errors.
- **String identifiers** — preserve customer and conversion-action IDs as strings; do not coerce them to JavaScript numbers.
- **Bounded I/O** — retain request timeouts, pagination limits, and retry guards. Provider responses are not trusted to be finite.
- **Normalized evidence** — map Google Ads DTOs to stable Canonry records before returning them to callers.

## Common Mistakes

- Treating a manager account ID as the selected client customer ID.
- Removing hyphens inconsistently when constructing the `login-customer-id` header.
- Adding write-capable OAuth scopes or mutation methods to a read-only integration.

## See Also

- `packages/contracts/src/google-ads.ts` — shared contracts
- `packages/contracts/src/google-marketing.ts` — cross-provider conversion-integrity contracts
- `packages/integration-google-ads/test/google-ads-client.test.ts` — provider boundary tests
