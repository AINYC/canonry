/**
 * What each branded answer SAYS about the brand.
 *
 * A model is the only thing that can read "I would not recommend them for
 * enterprise support" and call it a caution, and a model is the last thing that
 * should be trusted to assert it: asked for a verdict it will produce one, with
 * a fluent sentence to back it, whether or not the answer contains either. So
 * the same rule the mention extractor runs on applies here — the model
 * PROPOSES and exact matching DISPOSES.
 *
 * `verifyVerdict` is the arbiter. An evidence sentence survives only if the
 * answer literally contains it; a concern survives only if the answer literally
 * writes it, by `namesWrittenIn`'s adjacent-complete-words rule; and a verdict
 * with no surviving evidence collapses to `'none'`, because a verdict nothing
 * in the text carries is the model's opinion rather than the engine's.
 *
 * A failed extraction leaves `null`, never `'none'`. `'none'` says the answer
 * took no position, which is a finding about the answer; `null` says nobody
 * looked, which is a fact about the check. Collapsing the second into the first
 * turns an outage into a result.
 */
import { namesWrittenIn } from '../visibility/brand.js'
import { extractAnswerText, type GeminiContentClient, stripCodeFence } from '../visibility/gemini.js'
import { cleanText, clipText, createDeadlineSignal, throwIfAborted, uniqueStable } from '../visibility/runtime.js'
import type { PerceptionVerdict } from './types.js'

/** Bounds on one extraction call. Every one of these is a cost or a blast radius. */
export const VERDICT_EXTRACT_LIMITS = Object.freeze({
  maxAnswers: 3,
  maxAnswerChars: 4_000,
  maxEvidencePerAnswer: 3,
  maxEvidenceChars: 240,
  maxConcernsPerAnswer: 8,
  maxConcernChars: 64,
  maxOutputTokens: 1_024,
  timeoutMs: 12_000,
} as const)

const VERDICTS: readonly PerceptionVerdict[] = ['recommends', 'cautions', 'mixed', 'none']

/**
 * The response shape, enforced by the provider rather than hoped for. This call
 * uses no tool, so unlike the planner it can constrain its own output; without
 * the schema the model drifts between shapes and every drift reads as
 * "extraction failed".
 */
const VERDICT_EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          verdict: { type: 'string', enum: [...VERDICTS] },
          evidence: { type: 'array', items: { type: 'string' } },
          concerns: { type: 'array', items: { type: 'string' } },
        },
        required: ['index', 'verdict', 'evidence', 'concerns'],
      },
    },
  },
  required: ['answers'],
} as const

/** What the model claims about one answer, before any of it is verified. */
export interface VerdictProposal {
  verdict: PerceptionVerdict
  evidence: string[]
  concerns: string[]
}

export interface VerdictExtractor {
  /**
   * One proposal per input answer, in order. Never throws: a failure leaves
   * `null`, which is unmeasured, not "took no position".
   */
  extract(
    answers: ReadonlyArray<{ text: string; brandNames: string[] }>,
    signal?: AbortSignal,
  ): Promise<Array<VerdictProposal | null>>
}

export function buildVerdictExtractPrompt(answers: ReadonlyArray<{ text: string; brandNames: string[] }>): string {
  return [
    'You read answers about a company and report the position each one takes.',
    'Return JSON only, with this exact shape:',
    '{"answers":[{"index":1,"verdict":"recommends","evidence":["..."],"concerns":["..."]}]}.',
    'verdict is exactly one of: recommends, cautions, mixed, none.',
    'Use none when the text describes the company without taking a position on it.',
    'evidence: copy up to 3 sentences from the text WORD FOR WORD, exactly as written, that carry the verdict.',
    'Do not paraphrase, translate, summarise, correct, or join sentences. A sentence you did not copy will be discarded.',
    'concerns: up to 8 short phrases the text itself raises as drawbacks, each written in the text word for word.',
    'A text that takes no position gets "none" with an empty evidence array.',
    'Return one entry per text, in order.',
    ...answers.map((answer, index) => {
      const names = uniqueStable(answer.brandNames.map(cleanText).filter(Boolean))
      const subject = names.length > 0 ? ` (the company is: ${names.join(', ')})` : ''
      return `Text ${index + 1}${subject}:\n${answer.text}`
    }),
  ].join('\n')
}

/**
 * Strict parser. Anything unparsable yields nulls, so a bad response reads as
 * "not measured" rather than as answers that took no position.
 */
export function parseVerdictExtractResponse(text: string, answerCount: number): Array<VerdictProposal | null> {
  const out: Array<VerdictProposal | null> = Array.from({ length: answerCount }, () => null)
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(text))
  } catch {
    return out
  }
  const record = parsed && typeof parsed === 'object' ? parsed as { answers?: unknown } : null
  const rows = Array.isArray(record?.answers) ? record.answers : []
  for (const [position, row] of rows.slice(0, answerCount).entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const entry = row as { index?: unknown; verdict?: unknown; evidence?: unknown; concerns?: unknown }
    // A row without a usable index is answer N by position. The schema asks for
    // one; this is the single drift that still maps back unambiguously.
    const index = typeof entry.index === 'number' ? Math.trunc(entry.index) - 1 : position
    if (!Number.isInteger(index) || index < 0 || index >= answerCount) continue
    const verdict = VERDICTS.find((candidate) => candidate === entry.verdict)
    // An unrecognised verdict is not a verdict. Leaving the row null keeps it
    // unmeasured instead of inventing a position for it.
    if (!verdict) continue
    out[index] = {
      verdict,
      evidence: boundedStrings(
        entry.evidence,
        VERDICT_EXTRACT_LIMITS.maxEvidencePerAnswer,
        VERDICT_EXTRACT_LIMITS.maxEvidenceChars,
      ),
      concerns: boundedStrings(
        entry.concerns,
        VERDICT_EXTRACT_LIMITS.maxConcernsPerAnswer,
        VERDICT_EXTRACT_LIMITS.maxConcernChars,
      ),
    }
  }
  return out
}

function boundedStrings(value: unknown, maxEntries: number, maxChars: number): string[] {
  const raw = Array.isArray(value) ? value : []
  return uniqueStable(
    raw.flatMap((entry) => typeof entry === 'string' ? [clipText(cleanText(entry), maxChars).value] : [])
      .filter((entry) => entry.length > 0),
  ).slice(0, maxEntries)
}

/**
 * The arbiter, and the reason this is a measurement rather than a model's
 * opinion. Everything the model proposed is re-checked against the answer.
 */
export function verifyVerdict(
  answerText: string,
  proposal: VerdictProposal,
): { verdict: PerceptionVerdict; evidenceSentences: string[]; concerns: string[] } {
  const haystack = collapse(answerText)
  // Verified against the whole prose, independently of the verdict: a drawback
  // the answer writes is written whether or not the model's verdict survived.
  const concerns = namesWrittenIn(
    answerText,
    proposal.concerns.map((concern) => clipText(cleanText(concern), VERDICT_EXTRACT_LIMITS.maxConcernChars).value),
  ).slice(0, VERDICT_EXTRACT_LIMITS.maxConcernsPerAnswer)

  // `'none'` is a position of its own — "the answer took none" — so it carries
  // no evidence and needs none.
  if (proposal.verdict === 'none') return { verdict: 'none', evidenceSentences: [], concerns }

  const evidenceSentences = proposal.evidence
    .map((sentence) => clipText(cleanText(sentence), VERDICT_EXTRACT_LIMITS.maxEvidenceChars).value)
    .filter((sentence) => sentence.length > 0 && haystack.includes(collapse(sentence)))
    .slice(0, VERDICT_EXTRACT_LIMITS.maxEvidencePerAnswer)

  // A verdict nothing in the answer carries is the model's, not the engine's.
  if (evidenceSentences.length === 0) return { verdict: 'none', evidenceSentences: [], concerns }
  return { verdict: proposal.verdict, evidenceSentences, concerns }
}

/** Whitespace-collapsed and lower-cased, so re-wrapped prose still matches literally. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en')
}

export function createGeminiVerdictExtractor(
  options: { client: GeminiContentClient; model: string },
): VerdictExtractor {
  return {
    async extract(answers, signal) {
      const usable = answers.slice(0, VERDICT_EXTRACT_LIMITS.maxAnswers)
      const clipped = usable.map((answer) => ({
        text: clipText(cleanText(answer.text), VERDICT_EXTRACT_LIMITS.maxAnswerChars).value,
        brandNames: answer.brandNames,
      }))
      const unmeasured: Array<VerdictProposal | null> = answers.map(() => null)
      if (clipped.every((answer) => answer.text.length === 0)) return unmeasured

      const deadline = createDeadlineSignal(signal, VERDICT_EXTRACT_LIMITS.timeoutMs)
      try {
        throwIfAborted(deadline.signal)
        const response = await options.client.models.generateContent({
          model: options.model,
          contents: buildVerdictExtractPrompt(clipped),
          config: {
            temperature: 0,
            candidateCount: 1,
            maxOutputTokens: VERDICT_EXTRACT_LIMITS.maxOutputTokens,
            // No tool here, so unlike the planner this call can constrain its
            // own output instead of hand-parsing a fence.
            responseMimeType: 'application/json',
            responseSchema: VERDICT_EXTRACT_SCHEMA,
            // Thinking is on by default on 2.5 and is billed from the same
            // output allowance, so an unset budget lets the model spend it all
            // reasoning and return empty text. Copying sentences out of a text
            // needs no reasoning.
            thinkingConfig: { thinkingBudget: 0 },
            abortSignal: deadline.signal,
          },
        })
        const proposals = parseVerdictExtractResponse(extractAnswerText(response), clipped.length)
        return answers.map((_, index) => proposals[index] ?? null)
      } catch {
        // A failed extraction is unmeasured. Reporting "took no position" here
        // would invent a finding out of an outage.
        return unmeasured
      } finally {
        deadline.dispose()
      }
    },
  }
}
