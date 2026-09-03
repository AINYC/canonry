# @canonry/val-kit

The code two or more vals share. It is published to public npm because Val Town resolves a fully-qualified
`npm:@canonry/val-kit@<version>/<subpath>` specifier at runtime and ignores import maps — a workspace link cannot
reach a deployed val.

## The seam

A module belongs here only if all of these hold:

- **Pure and host-agnostic.** It reads no environment, no storage, and no HTTP state of its own. Whatever it needs
  from a host — the environment object, a SQLite client, a `fetch`, an `AbortSignal` — arrives as a parameter.
- **No host imports.** Never `hono`, never `@canonry/aeo-audit`, never anything from `esm.town`, and never a `Deno.`
  global. `deno.json`, an import map, and a `main.http.tsx` are the val's business.
- **No product surface.** No product name, no page copy, no error sentence a visitor reads, no MCP tool that
  describes one val's offering. A val owns what it IS; the kit owns what it runs on. `createRequestBoundDispatcher`
  is generic; `createPublicCheckRunner` — which knows the phases, their budget, and every sentence a failure
  produces — is not, and stays with the val.

The test for a candidate is mechanical: if it references a visibility or site-health type, string, or phase, it is
not generic, whatever else is true of it.

## Subpaths

`.`, `./visibility`, `./security`, `./storage`, `./jobs`, `./mcp`, `./ui`, `./config`. Each is a `src/<name>.ts`
barrel and a tsup entry; `.` re-exports the rest. Adding a subpath means adding all three (barrel, tsup entry,
`exports` map) or a consumer gets a resolution error rather than a type error.

`VisibilitySource` is declared twice in the seam with two different shapes — the adapter-facing source in
`visibility/contracts.ts` and the display-safe source stored on a record in `runtime/types.ts`. Two star re-exports
of one name are ambiguous, which drops it from the root barrel silently, so `src/index.ts` names the winner
explicitly. Keep that line if either declaration moves.

## Build

tsup to ESM + `.d.ts`. Deno consumes an npm package as BUILT JavaScript — it does not run TypeScript out of
`node_modules` — so an unbuilt `dist/` is a broken publish, not a slow one. Relative imports carry a `.js`
extension (repo convention; tsup and tsc resolve them to the `.ts` source).

## Versioning and publishing

Vals pin an EXACT version (`npm:@canonry/val-kit@0.1.0/...`), so a change here reaches a val only when its
specifier is bumped. Before publishing, a val resolves the kit locally through Deno `links` so an unreleased change
can be run end to end; after publishing, the pin moves.

Publishing is a manual workflow. It is not part of the Canonry release, and the kit's version is independent of
`packages/canonry`.

## `src/mcp/skills/` is generated

Edit `skills/<name>/` at the repository root, then run `node scripts/sync-val-town-skills.mjs` and commit the
result. `--check` fails instead of writing, which is what CI runs. Never hand-edit a generated module; the next
sync overwrites it.

## Tests

`packages/val-kit/test/`, vitest, run by the root suite as the `val-kit` project. Every module the kit owns keeps
the coverage it had as val-local code — a module that moved in without its tests moved in untested. `storage.test.ts`
uses `node:sqlite` as a stand-in for Val Town's SQLite over the same `ValSqliteClient` interface, which is the point
of the store taking an interface rather than a binding.
