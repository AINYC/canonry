/**
 * Which brands each answer NAMES in its prose.
 *
 * Citation share needs no help: a source carries its own domain. Mention share
 * does, because a mention is a name written in text and the check has no list
 * of rival names to look for. The target's own aliases come from the planner
 * call; rivals only appear after the probes have run, so nothing before this
 * point knows what to search the prose for.
 *
 * What is emphatically NOT done here is deriving a name from a cited domain.
 * `contracts.ts` is explicit that the probe never silently turns a domain into
 * a prose alias, and "hubspot.com is in the sources, therefore the word HubSpot
 * in this answer is a rival mention" is exactly that inference.
 *
 * So the model PROPOSES and exact matching DISPOSES. One extra bounded call
 * reads the answers back and lists the names each one writes; every proposal is
 * then re-checked against the prose with `namesWrittenIn`, the same
 * adjacent-complete-words rule the target's own verdict uses. A name the model
 * invented, expanded, or translated is not in the text, so it is dropped. The
 * metric still rests on exact matching; the call only supplies candidates.
 */
import { namesWrittenIn } from './brand.js'
import { extractAnswerText, type GeminiContentClient } from './gemini.js'
import { cleanText, clipText, createDeadlineSignal, throwIfAborted, uniqueStable } from './runtime.js'

/** Bounds on one extraction call. Every one of these is a cost or a blast radius. */
export const MENTION_EXTRACT_LIMITS = Object.freeze({
  maxAnswers: 3,
  maxAnswerChars: 4_000,
  maxNamesPerAnswer: 12,
  maxNameChars: 64,
  maxOutputTokens: 1_024,
  timeoutMs: 12_000,
})

/**
 * The response shape, enforced by the provider rather than hoped for. Without
 * it the model drifts between {index, brands} objects, bare arrays, and keyed
 * objects, and every drift reads as "extraction failed".
 */
const MENTION_EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          brands: { type: 'array', items: { type: 'string' } },
        },
        required: ['index', 'brands'],
      },
    },
  },
  required: ['answers'],
} as const

export interface NamedBrandExtractor {
  /** One list per input answer, in the same order. Never throws: an extraction
   * failure leaves mentions unmeasured, which is not the same as none found. */
  extract(answers: readonly string[], signal?: AbortSignal): Promise<Array<string[] | null>>
}

export function buildMentionExtractPrompt(answers: readonly string[]): string {
  return [
    'You list the company, product, and brand names that a text NAMES.',
    'Return JSON only, with this exact shape: {"answers":[{"index":1,"brands":["..."]}]}.',
    'Copy each name exactly as the text writes it. Do not translate, expand an abbreviation, correct spelling, or add a name the text does not write.',
    'Do not list generic categories, job titles, product types, or the reader.',
    'Return one entry per text, in order. A text that names none gets an empty array.',
    ...answers.map((answer, index) => `Text ${index + 1}:\n${answer}`),
  ].join('\n')
}

/**
 * Strict parser. Anything unparsable yields nulls, so a bad response reads as
 * "not measured" rather than as answers that named nobody.
 */
export function parseMentionExtractResponse(responseText: string, answerCount: number): Array<string[] | null> {
  const out: Array<string[] | null> = Array.from({ length: answerCount }, () => null)
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(responseText))
  } catch {
    return out
  }
  const record = parsed as { answers?: unknown } | null
  const rows = Array.isArray(record?.answers) ? record.answers : []
  for (const [position, row] of rows.slice(0, answerCount).entries()) {
    if (typeof row !== 'object' || row === null) continue
    // A bare array at position N is answer N. The schema asks for {index,
    // brands}; this is the one drift that still maps back unambiguously.
    const entry = Array.isArray(row)
      ? { index: position + 1, brands: row }
      : row as { index?: unknown; brands?: unknown }
    const index = typeof entry.index === 'number' ? Math.trunc(entry.index) - 1 : -1
    if (!Number.isInteger(index) || index < 0 || index >= answerCount) continue
    const brands = Array.isArray(entry.brands) ? entry.brands : []
    out[index] = uniqueStable(
      brands.flatMap((value) => typeof value === 'string' ? [cleanText(value)] : [])
        .filter((name) => name.length > 0 && name.length <= MENTION_EXTRACT_LIMITS.maxNameChars),
    ).slice(0, MENTION_EXTRACT_LIMITS.maxNamesPerAnswer)
  }
  return out
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) return trimmed
  const firstNewline = trimmed.indexOf('\n')
  if (firstNewline === -1) return trimmed
  const language = trimmed.slice(3, firstNewline).trim().toLowerCase()
  if (language && language !== 'json') return trimmed
  return trimmed.slice(firstNewline + 1, -3).trim()
}

export function createGeminiBrandExtractor(
  options: { client: GeminiContentClient; model: string },
): NamedBrandExtractor {
  return {
    async extract(answers, signal) {
      const usable = answers.slice(0, MENTION_EXTRACT_LIMITS.maxAnswers)
      const clipped = usable.map((answer) => clipText(cleanText(answer), MENTION_EXTRACT_LIMITS.maxAnswerChars).value)
      const unmeasured: Array<string[] | null> = answers.map(() => null)
      if (clipped.every((answer) => answer.length === 0)) return unmeasured

      const deadline = createDeadlineSignal(signal, MENTION_EXTRACT_LIMITS.timeoutMs)
      try {
        throwIfAborted(deadline.signal)
        const response = await options.client.models.generateContent({
          model: options.model,
          contents: buildMentionExtractPrompt(clipped),
          config: {
            temperature: 0,
            candidateCount: 1,
            maxOutputTokens: MENTION_EXTRACT_LIMITS.maxOutputTokens,
            // This call uses no tool, so unlike the planner it CAN constrain
            // its own output. The planner had to hand-parse a fence because
            // Gemini 2.5 refuses structured output alongside googleSearch.
            responseMimeType: 'application/json',
            responseSchema: MENTION_EXTRACT_SCHEMA,
            // Thinking is on by default on 2.5 and is billed from the same
            // output budget, so a reasoning model can spend the whole
            // allowance before writing a character and return empty text.
            // Copying names out of a text needs no reasoning.
            thinkingConfig: { thinkingBudget: 0 },
            abortSignal: deadline.signal,
          },
        })
        const text = extractAnswerText(response)
        const proposed = parseMentionExtractResponse(text, clipped.length)
        // The verification step, and the reason this is a measurement rather
        // than a model's opinion: a proposed name survives only if the answer
        // literally writes it.
        const verified = proposed.map((names, index) =>
          names === null ? null : namesWrittenIn(clipped[index] ?? '', names)
        )
        return answers.map((_, index) => verified[index] ?? null)
      } catch {
        // A failed extraction is unmeasured. Reporting "no brands named" here
        // would invent a finding out of an outage.
        return unmeasured
      } finally {
        deadline.dispose()
      }
    },
  }
}
