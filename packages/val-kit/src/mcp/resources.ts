/**
 * The bundled `canonry` and `aero` skills, served as MCP resources.
 *
 * This is the half of the endpoint that makes the other half worth connecting
 * to. Coverage numbers on their own need interpretation — which signal moved,
 * whether the denominator is comparable, what to do next — and that
 * interpretation is exactly what the two skills already write down. An agent
 * that reads them alongside the data behaves like an analyst instead of a JSON
 * pretty-printer.
 *
 * `resources/list` returns entry points and references together, with
 * `SKILL.md` first, so a client can load the entry point and open a reference
 * only when the task calls for it. That is the same contract a local install
 * has, so nothing new has to be explained to the agent.
 */
import type { SkillDocument } from './skill-types.js'
import { SKILL_DOCUMENTS } from './skills/catalog.js'

export const SKILL_RESOURCE_MIME_TYPE = 'text/markdown'

export interface McpResourceDescriptor {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
}

export interface McpResourceContents {
  uri: string
  mimeType: string
  text: string
}

/** Entry points first, then references, each group alphabetical by URI. */
const ORDERED_DOCUMENTS: readonly SkillDocument[] = [...SKILL_DOCUMENTS].sort((a, b) => {
  if (a.entryPoint !== b.entryPoint) return a.entryPoint ? -1 : 1
  return a.uri.localeCompare(b.uri)
})

const BY_URI = new Map(ORDERED_DOCUMENTS.map((document) => [document.uri, document]))

/**
 * Also index by `<skill>/<path>` and by bare path so a caller that reconstructs
 * a reference from prose in `SKILL.md` — which links them as
 * `references/reporting.md` — reaches the document instead of a not-found.
 */
const BY_ALIAS = new Map<string, SkillDocument>()
for (const document of ORDERED_DOCUMENTS) {
  BY_ALIAS.set(`${document.skill}/${document.path}`, document)
  const bare = document.path
  // A bare path is ambiguous only if two skills share it; first one wins and
  // the qualified form above always remains exact.
  if (!BY_ALIAS.has(bare)) BY_ALIAS.set(bare, document)
}

export function listSkillResources(): McpResourceDescriptor[] {
  return ORDERED_DOCUMENTS.map((document) => ({
    uri: document.uri,
    name: `${document.skill}/${document.path}`,
    title: document.title,
    description: document.entryPoint
      ? `Entry point for the ${document.skill} skill. ${document.description}`
      : document.description,
    mimeType: SKILL_RESOURCE_MIME_TYPE,
  }))
}

export function findSkillDocument(uri: string): SkillDocument | null {
  const trimmed = uri.trim()
  return BY_URI.get(trimmed) ?? BY_ALIAS.get(trimmed.replace(/^canonry-skill:\/\//, '')) ?? null
}

export function readSkillResource(uri: string): McpResourceContents | null {
  const document = findSkillDocument(uri)
  if (!document) return null
  return { uri: document.uri, mimeType: SKILL_RESOURCE_MIME_TYPE, text: document.content }
}

/** Compact index used by the `read_skill` tool, for clients without resource support. */
export function skillIndex(): Array<{ uri: string; skill: string; path: string; title: string; entryPoint: boolean }> {
  return ORDERED_DOCUMENTS.map((document) => ({
    uri: document.uri,
    skill: document.skill,
    path: document.path,
    title: document.title,
    entryPoint: document.entryPoint,
  }))
}
