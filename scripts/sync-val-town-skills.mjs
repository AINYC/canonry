/**
 * Mirror `skills/<name>/` into the Val Town val as TypeScript modules.
 *
 * The val serves both bundled skills as MCP resources, so an agent that
 * connects to it gets the analyst playbook alongside the data. It cannot read
 * them from `skills/` at runtime: a val is a flat file set rooted at
 * `apps/vals/ai-visibility-check/`, nothing outside that directory is pushed,
 * and Val Town caps a single file at 80,000 characters.
 * `skills/canonry/references/canonry-cli.md` is 101,329, so a straight copy is
 * not an option either.
 *
 * Hence generated modules, chunked so that no emitted file approaches the cap.
 * Content is written with `JSON.stringify` rather than a template literal
 * because the source is markdown: it is full of backticks and `${`, and every
 * one of them would need escaping by hand.
 *
 * Run `node scripts/sync-val-town-skills.mjs` after editing anything under
 * `skills/`, and commit the result. `--check` fails instead of writing, which
 * is what CI runs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skillsRoot = path.join(repoRoot, 'skills')
const outputRoot = path.join(repoRoot, 'apps', 'vals', 'ai-visibility-check', 'src', 'mcp', 'skills')
const managedSkills = ['aero', 'canonry']

/**
 * Val Town's hard per-file limit. Chunks are sized against the ESCAPED length,
 * because that is what lands in the file — a 50,000-character slice of markdown
 * is slightly longer once `JSON.stringify` escapes its newlines.
 */
const VAL_TOWN_FILE_CHAR_LIMIT = 80_000
const MAX_ESCAPED_CHUNK_CHARS = 60_000

function parseArgs(argv) {
  let checkOnly = false
  for (const arg of argv) {
    if (arg === '--check') checkOnly = true
    else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return { checkOnly }
}

/** Every markdown file under a skill, deterministically ordered. */
function collectSkillFiles(skill) {
  const root = path.join(skillsRoot, skill)
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(absolute)
    }
  }
  walk(root)
  // SKILL.md is the entry point, so it sorts first regardless of directory order.
  return found.sort((a, b) => {
    const aEntry = path.basename(a) === 'SKILL.md' ? 0 : 1
    const bEntry = path.basename(b) === 'SKILL.md' ? 0 : 1
    return aEntry - bEntry || a.localeCompare(b)
  })
}

/**
 * Read `name` and `description` out of YAML frontmatter without a YAML parser.
 * Only these two scalars are needed and both are single-line in every bundled
 * skill; anything more would justify a dependency, and this would be the wrong
 * place to grow one.
 */
function readFrontmatter(source) {
  if (!source.startsWith('---\n')) return {}
  const end = source.indexOf('\n---', 4)
  if (end === -1) return {}
  const block = source.slice(4, end)
  const read = (key) => {
    // Top-level keys only: a nested `metadata:` block is indented, and matching
    // it here would pull `metadata.description` into a skill's trigger surface.
    const match = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
    if (!match) return null
    const raw = match[1].trim()
    if (!raw) return null
    if (
      (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) ||
      (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1)
    ) {
      const inner = raw.slice(1, -1)
      return raw.startsWith('"') ? inner.replace(/\\"/g, '"') : inner.replace(/''/g, "'")
    }
    return raw
  }
  return { name: read('name'), description: read('description') }
}

/** First markdown heading, used as the title for reference documents. */
function readHeading(source) {
  const match = source.match(/^#[ \t]+(.+)$/m)
  return match ? match[1].trim() : null
}

function slugify(skill, relativePath) {
  const withoutExtension = relativePath.replace(/\.md$/, '')
  return `${skill}-${withoutExtension}`.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
}

/**
 * Split so that each part's ESCAPED length stays under the chunk ceiling.
 * Splitting on the escaped length rather than the raw length is what keeps the
 * guarantee honest for content with many newlines or quotes.
 */
function chunkContent(content) {
  const chunks = []
  let remaining = content
  while (remaining.length > 0) {
    let take = remaining.length
    while (take > 1 && JSON.stringify(remaining.slice(0, take)).length > MAX_ESCAPED_CHUNK_CHARS) {
      take = Math.floor(take * 0.9)
    }
    chunks.push(remaining.slice(0, take))
    remaining = remaining.slice(take)
  }
  return chunks.length > 0 ? chunks : ['']
}

const GENERATED_BANNER = [
  '// Generated by scripts/sync-val-town-skills.mjs. Do not edit.',
  '// Source of truth: skills/<name>/ at the repository root.',
  '',
].join('\n')

function renderPartModule(chunk) {
  return `${GENERATED_BANNER}export const part = ${JSON.stringify(chunk)}\n`
}

function renderCatalogModule(documents) {
  const imports = []
  const entries = []

  for (const document of documents) {
    const identifiers = document.parts.map((_, index) => {
      const identifier = `${document.slug.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase())}Part${index}`
      imports.push(`import { part as ${identifier} } from './${document.slug}.${index}.ts'`)
      return identifier
    })
    const content = identifiers.length === 1 ? identifiers[0] : `[${identifiers.join(', ')}].join('')`
    entries.push(
      [
        '  {',
        `    uri: ${JSON.stringify(document.uri)},`,
        `    skill: ${JSON.stringify(document.skill)},`,
        `    path: ${JSON.stringify(document.relativePath)},`,
        `    title: ${JSON.stringify(document.title)},`,
        `    description: ${JSON.stringify(document.description)},`,
        `    entryPoint: ${document.entryPoint},`,
        `    characters: ${document.characters},`,
        `    content: ${content},`,
        '  },',
      ].join('\n'),
    )
  }

  return [
    GENERATED_BANNER,
    "import type { SkillDocument } from '../skill-types.ts'",
    '',
    imports.join('\n'),
    '',
    'export const SKILL_DOCUMENTS: readonly SkillDocument[] = [',
    entries.join('\n'),
    ']',
    '',
  ].join('\n')
}

function buildFiles() {
  const documents = []

  for (const skill of managedSkills) {
    for (const absolute of collectSkillFiles(skill)) {
      const relativePath = path.relative(path.join(skillsRoot, skill), absolute).split(path.sep).join('/')
      const source = fs.readFileSync(absolute, 'utf8')
      const frontmatter = readFrontmatter(source)
      const entryPoint = path.basename(absolute) === 'SKILL.md'
      documents.push({
        skill,
        relativePath,
        slug: slugify(skill, relativePath),
        uri: `canonry-skill://${skill}/${relativePath}`,
        title: entryPoint ? `${skill} skill` : readHeading(source) ?? relativePath,
        // A reference has no frontmatter; naming its skill keeps a bare
        // `resources/list` entry meaningful without opening the document.
        description: frontmatter.description ?? `${skill} skill reference: ${relativePath}`,
        entryPoint,
        characters: source.length,
        parts: chunkContent(source),
      })
    }
  }

  const files = new Map()
  for (const document of documents) {
    document.parts.forEach((chunk, index) => {
      files.set(path.join(outputRoot, `${document.slug}.${index}.ts`), renderPartModule(chunk))
    })
  }
  files.set(path.join(outputRoot, 'catalog.ts'), renderCatalogModule(documents))

  for (const [file, contents] of files) {
    if (contents.length > VAL_TOWN_FILE_CHAR_LIMIT) {
      throw new Error(
        `${path.relative(repoRoot, file)} is ${contents.length} characters, over Val Town's ${VAL_TOWN_FILE_CHAR_LIMIT} limit.`,
      )
    }
  }
  return { files, documents }
}

function main() {
  const { checkOnly } = parseArgs(process.argv.slice(2))
  const { files, documents } = buildFiles()

  const existing = fs.existsSync(outputRoot)
    ? new Set(fs.readdirSync(outputRoot).filter((name) => name.endsWith('.ts')).map((name) => path.join(outputRoot, name)))
    : new Set()

  const drift = []
  for (const [file, contents] of files) {
    const current = existing.has(file) ? fs.readFileSync(file, 'utf8') : null
    if (current !== contents) drift.push(path.relative(repoRoot, file))
  }
  // A renamed or deleted skill file must remove its module too, or the val
  // keeps serving a resource that no longer exists upstream.
  const stale = [...existing].filter((file) => !files.has(file)).map((file) => path.relative(repoRoot, file))

  if (checkOnly) {
    if (drift.length === 0 && stale.length === 0) {
      console.log(`Val Town skill mirror is current (${documents.length} documents, ${files.size} modules).`)
      return
    }
    for (const file of drift) console.error(`::error::Out of date: ${file}`)
    for (const file of stale) console.error(`::error::Stale, no longer generated: ${file}`)
    console.error('Run `node scripts/sync-val-town-skills.mjs` and commit the result.')
    process.exit(1)
  }

  fs.mkdirSync(outputRoot, { recursive: true })
  for (const file of stale) fs.rmSync(path.join(repoRoot, file))
  for (const [file, contents] of files) fs.writeFileSync(file, contents)

  const totalCharacters = documents.reduce((sum, document) => sum + document.characters, 0)
  console.log(
    `Mirrored ${documents.length} skill documents (${totalCharacters.toLocaleString('en-US')} characters) into ${files.size} modules.`,
  )
  for (const file of stale) console.log(`Removed stale ${file}`)
}

main()
