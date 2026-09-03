/**
 * One bundled skill document, served as an MCP resource.
 *
 * The shape mirrors how the skills are meant to be read: `entryPoint` marks
 * `SKILL.md`, which a connecting agent should load first, and everything else
 * is a reference it opens only when the task calls for it. That is the same
 * lazy-load contract the skills already have in a local install, so an agent
 * reaching them over MCP does not need a second set of rules.
 */
export interface SkillDocument {
  /** Stable `canonry-skill://<skill>/<path>` identity. */
  uri: string
  skill: string
  /** Path relative to the skill root, for example `references/reporting.md`. */
  path: string
  title: string
  /**
   * For an entry point this is the skill's frontmatter `description` — its
   * entire trigger surface. For a reference it names the owning skill.
   */
  description: string
  entryPoint: boolean
  characters: number
  content: string
}
