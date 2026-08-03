import { describe, expect, it } from 'vitest'

import { buildMeasurementEvidence, type MeasurementAnswerEvidence } from '../src/measurement-report.js'
import { answerEvidenceInput } from './measurement-answer-evidence-fixture.js'
import { FLAT_EVIDENCE_BASELINE } from './measurement-flat-evidence-baseline.js'

function answers(): MeasurementAnswerEvidence[] {
  return buildMeasurementEvidence(answerEvidenceInput()).answers
}

function answerFor(slotId: string, edgeId: string): MeasurementAnswerEvidence {
  const row = answers().find(candidate => candidate.expectedSlotId === slotId && candidate.usageEdgeId === edgeId)
  if (!row) throw new Error(`No answer row for ${slotId} / ${edgeId}`)
  return row
}

describe('answer-level measurement evidence', () => {
  it('emits a row for an answer that cited nobody', () => {
    const loss = answers().filter(row => row.expectedSlotId === 'slot-loss')

    expect(loss.map(row => row.usageEdgeId)).toEqual(['edge-harbor-loss', 'edge-north-loss'])
    for (const row of loss) {
      expect(row.sources).toEqual([])
      expect(row.cited).toBe(false)
      // The engine did answer, so the mention signal is a real reading here.
      expect(row.mentioned).toBe(false)
    }
  })

  it('reports mention against the Property the row belongs to', () => {
    // "Northstar North is another option." names one Property and not the other,
    // and both read the same answer through their own usage edge.
    expect(answerFor('slot-shared-gemini', 'edge-north-shared').mentioned).toBe(true)
    expect(answerFor('slot-shared-gemini', 'edge-harbor-shared').mentioned).toBe(false)
  })

  it('leaves mention unknown when the answer text never landed', () => {
    const silent = answerFor('slot-silent', 'edge-north-silent')

    expect(silent.mentioned).toBeNull()
    expect(silent.mentioned).not.toBe(false)
    // The citation signal is independent: this answer has a source even though
    // its text is gone, so an unknown mention must not suppress the row.
    expect(silent.cited).toBe(true)
  })

  it('gives one answer used by two Properties a row each', () => {
    const shared = answers().filter(row => row.expectedSlotId === 'slot-shared-openai' && row.usageEdgeType === 'target')

    expect(shared).toHaveLength(2)
    expect(shared.map(row => row.usageEdgeId)).toEqual(['edge-harbor-shared', 'edge-north-shared'])
    expect(new Set(shared.map(row => row.observationId))).toEqual(new Set(['observation-openai']))
    // Same answer, same three sources, different Property — so the assigned
    // reading differs while the source list does not.
    expect(shared[0]?.cited).toBe(true)
    expect(shared[1]?.cited).toBe(false)
  })

  it('nests the sources with the classification each URL has today', () => {
    const harbor = answerFor('slot-shared-openai', 'edge-harbor-shared')

    expect(harbor.sources).toEqual([
      {
        sourceUrl: 'https://challenger.example/compare',
        normalizedUrl: 'https://challenger.example/compare',
        classification: 'external',
        matchedTargetIds: [],
        matchedUrlIds: [],
      },
      {
        sourceUrl: 'https://northstar.example/locations/harbor/details',
        normalizedUrl: 'https://northstar.example/locations/harbor/details',
        classification: 'assigned',
        matchedTargetIds: ['harbor'],
        matchedUrlIds: ['harbor-url'],
      },
      {
        sourceUrl: 'https://northstar.example/shared/guide',
        normalizedUrl: 'https://northstar.example/shared/guide',
        classification: 'ambiguous',
        matchedTargetIds: ['shared-a', 'shared-b'],
        matchedUrlIds: ['shared-a-url', 'shared-b-url'],
      },
    ])
  })

  it('carries the frozen question class of the usage edge', () => {
    const classed = buildMeasurementEvidence(answerEvidenceInput({
      usageEdges: answerEvidenceInput().usageEdges.map(edge => edge.type === 'target' && edge.targetId === 'north'
        ? { ...edge, queryClass: 'non-brand' as const }
        : edge),
    })).answers

    expect(answerFor('slot-shared-openai', 'edge-north-shared').queryClass).toBeNull()
    expect(classed.find(row => row.usageEdgeId === 'edge-north-shared')?.queryClass).toBe('non-brand')
    // A baseline edge belongs to no Property, so it never carries a class.
    expect(classed.find(row => row.usageEdgeId === 'edge-baseline')?.queryClass).toBeNull()
  })

  it('keeps the run provenance of the observation on every row', () => {
    const bridged = answerFor('slot-shared-gemini', 'edge-north-shared')

    expect(bridged).toMatchObject({ bridged: true, historical: true, evidenceComplete: true })
  })
})

describe('flat evidence derived from the answer rows', () => {
  it('is byte-identical to what the kernel produced before the answer rows existed', () => {
    const { evidence } = buildMeasurementEvidence(answerEvidenceInput())

    expect(evidence).toEqual(FLAT_EVIDENCE_BASELINE)
    // Key order too: the flat rows are a published wire shape, so a reordered
    // object would be a visible change even though `toEqual` accepts it.
    expect(JSON.stringify(evidence)).toBe(JSON.stringify(FLAT_EVIDENCE_BASELINE))
  })

  it('has one flat row per answer-row source and no others', () => {
    const { answers: rows, evidence } = buildMeasurementEvidence(answerEvidenceInput())

    expect(evidence).toHaveLength(rows.reduce((total, row) => total + row.sources.length, 0))
    expect(rows.some(row => row.sources.length === 0)).toBe(true)
  })
})

describe('a signal the run cannot support is never a measured negative', () => {
  // A Property whose aliases tokenize to nothing can never match answer text.
  // The rate path already reports that as `aliasless`; an answer row that said
  // "not mentioned" would state a negative the run never measured.
  it('leaves mention unknown for a Property with no usable alias', () => {
    const input = answerEvidenceInput()
    const rows = buildMeasurementEvidence({
      ...input,
      targets: input.targets.map(target => (
        target.id === 'north' ? { ...target, aliases: ['', '  '] } : target
      )),
    }).answers

    const north = rows.filter(row => row.usageEdgeId.includes('north') && row.usageEdgeType === 'target')
    expect(north.length).toBeGreaterThan(0)
    for (const row of north) expect(row.mentioned).toBeNull()

    // The Property that CAN be matched is unaffected, so this is not a blanket null.
    const harbor = rows.filter(row => row.usageEdgeId.includes('harbor') && row.usageEdgeType === 'target')
    expect(harbor.some(row => row.mentioned !== null)).toBe(true)
  })

  it('leaves cited unknown when the sources were never fully captured', () => {
    const input = answerEvidenceInput()
    const rows = buildMeasurementEvidence({
      ...input,
            // The fixture mixes live and recovered observations, so both
      // completeness flags have to go down to model "sources never captured".
      observations: input.observations.map(observation => ({
        ...observation,
        citedUrlsComplete: false,
        historicalCitedUrlsComplete: false,
      })),
    }).answers

    // Nothing matched AND capture was incomplete: we cannot tell "not cited"
    // from "we never saw the sources".
    const uncited = rows.filter(row => row.sources.every(source => source.classification !== 'assigned'))
    expect(uncited.length).toBeGreaterThan(0)
    for (const row of uncited) expect(row.cited).toBeNull()

    // A source we DID see and matched is still a citation.
    const matched = rows.filter(row => row.sources.some(source => source.classification === 'assigned'))
    for (const row of matched) expect(row.cited).toBe(true)
  })
})
