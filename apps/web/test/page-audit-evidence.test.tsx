import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { PageAuditEvidence } from '../src/components/project/PageAuditEvidence.js'

afterEach(cleanup)

test('connects a page score to its exact audit findings and fixes', () => {
  render(
    <PageAuditEvidence
      audit={{
        state: 'ready',
        project: 'citypoint',
        runId: 'run_1',
        complete: true,
        termination: null,
        nodeKey: 'page_services',
        url: 'https://citypoint.example/services',
        auditState: 'complete',
        auditScore: 42,
        evidenceState: 'complete',
        factors: [
          {
            id: 'content-depth',
            name: 'Content depth',
            weight: 12,
            score: 20,
            status: 'fail',
            applicable: true,
            findings: [{ type: 'missing', code: 'content-depth.word-count.low', message: 'Only 120 words were found.' }],
            recommendations: ['Answer the key questions visitors ask on this page.'],
          },
          {
            id: 'structured-data',
            name: 'Structured data',
            weight: 10,
            score: 90,
            status: 'pass',
            applicable: true,
            findings: [{ type: 'found', code: 'structured-data.present', message: 'Valid schema was found.' }],
            recommendations: [],
          },
        ],
        criticalDefects: [{
          id: 'missing-h1',
          severity: 'critical',
          detail: 'No H1 tag was found.',
          recommendation: 'Add one descriptive H1.',
        }],
      }}
      isLoading={false}
      error={null}
      onRetry={vi.fn()}
    />,
  )

  expect(screen.getByRole('heading', { name: 'Findings and fixes' })).not.toBeNull()
  expect(screen.getByLabelText('Score 42 out of 100')).not.toBeNull()
  expect(screen.getByText('No H1 tag was found.')).not.toBeNull()
  expect(screen.getByText('Not counted in the score')).not.toBeNull()
  expect(screen.getByText('Critical')).not.toBeNull()
  const factor = screen.getByText('Content depth').closest('details')
  expect(factor).not.toBeNull()
  expect(within(factor!).getByText('Only 120 words were found.')).not.toBeNull()
  expect(within(factor!).getByText('Answer the key questions visitors ask on this page.')).not.toBeNull()
  expect(screen.queryByText('Structured data')).toBeNull()
})

test('labels legacy page evidence as scores-only instead of claiming there were no findings', () => {
  render(
    <PageAuditEvidence
      audit={{
        state: 'ready',
        project: 'citypoint',
        runId: 'run_old',
        complete: true,
        termination: null,
        nodeKey: 'page_home',
        url: 'https://citypoint.example/',
        auditState: 'complete',
        auditScore: 61,
        evidenceState: 'scores-only',
        factors: [{
          id: 'content-depth',
          name: 'Content depth',
          weight: 12,
          score: 35,
          status: 'fail',
          applicable: null,
          findings: [],
          recommendations: [],
        }],
        criticalDefects: [],
      }}
      isLoading={false}
      error={null}
      onRetry={vi.fn()}
    />,
  )

  expect(screen.getByText(/saved only the scores, not the findings/i)).not.toBeNull()
  expect(screen.getByText('Content depth')).not.toBeNull()
  expect(screen.queryByText(/No technical findings/)).toBeNull()
})

test('does not infer a clean page from a legacy scan with only passing scores', () => {
  render(
    <PageAuditEvidence
      audit={{
        state: 'ready', project: 'citypoint', runId: 'run_old', complete: true, termination: null,
        nodeKey: 'page_home', url: 'https://citypoint.example/', auditState: 'complete', auditScore: 90,
        evidenceState: 'scores-only', criticalDefects: [],
        factors: [{
          id: 'structured-data', name: 'Structured data', weight: 10, score: 90,
          status: 'pass', applicable: null, findings: [], recommendations: [],
        }],
      }}
      isLoading={false}
      error={null}
      onRetry={vi.fn()}
    />,
  )

  expect(screen.getByText(/saved only the score\. Run a new scan/i)).not.toBeNull()
  expect(screen.queryByText(/No technical findings need attention/)).toBeNull()
})

test('shows a truthful retry state when page audit evidence cannot be loaded', () => {
  const onRetry = vi.fn()
  render(<PageAuditEvidence audit={undefined} isLoading={false} error={new Error('offline')} onRetry={onRetry} />)

  expect(screen.getByRole('alert').textContent).toContain('Findings could not be loaded.')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(onRetry).toHaveBeenCalledOnce()
})

test('renders repeated finding codes as distinct occurrences without duplicate React keys', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

  render(
    <PageAuditEvidence
      audit={{
        state: 'ready', project: 'citypoint', runId: 'run_1', complete: true, termination: null,
        nodeKey: 'page_home', url: 'https://citypoint.example/', auditState: 'complete', auditScore: 20,
        evidenceState: 'complete', criticalDefects: [],
        factors: [{
          id: 'ai-crawler-access', name: 'AI crawler access', weight: 20, score: 20,
          status: 'fail', applicable: true, recommendations: [],
          findings: [
            { type: 'missing', code: 'ai-crawler-access.crawler.blocked', message: 'GPTBot is blocked.' },
            { type: 'missing', code: 'ai-crawler-access.crawler.blocked', message: 'ClaudeBot is blocked.' },
          ],
        }],
      }}
      isLoading={false}
      error={null}
      onRetry={vi.fn()}
    />,
  )

  expect(screen.getByText('GPTBot is blocked.')).not.toBeNull()
  expect(screen.getByText('ClaudeBot is blocked.')).not.toBeNull()
  expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key')
  consoleError.mockRestore()
})
