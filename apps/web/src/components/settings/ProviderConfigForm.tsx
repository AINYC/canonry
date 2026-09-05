import { useState } from 'react'

import { Button } from '../ui/button.js'
import { updateProviderConfig } from '../../api.js'
import { addToast } from '../../lib/toast-store.js'
import { asyncHandler } from '../../lib/async-handler.js'

export function ProviderConfigForm({ providerName, keyUrl, modelHint, compact = false, onSaved }: {
  providerName: string
  keyUrl?: string
  modelHint?: string
  /** Keep optional tuning out of the first-run provider connection path. */
  compact?: boolean
  onSaved: () => void
}) {
  const isLocal = providerName.toLowerCase() === 'local'
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [maxConcurrency, setMaxConcurrency] = useState('')
  const [maxPerMinute, setMaxPerMinute] = useState('')
  const [maxPerDay, setMaxPerDay] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const canSave = isLocal ? baseUrl.trim().length > 0 : apiKey.trim().length > 0

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    setSuccess(false)
    try {
      const parseQuotaField = (s: string): number | undefined => {
        const n = parseInt(s.trim(), 10)
        return Number.isFinite(n) && n > 0 ? n : undefined
      }
      const quota: { maxConcurrency?: number; maxRequestsPerMinute?: number; maxRequestsPerDay?: number } = {}
      const maxConcurrencyVal = parseQuotaField(maxConcurrency)
      if (maxConcurrencyVal !== undefined) quota.maxConcurrency = maxConcurrencyVal
      const maxPerMinuteVal = parseQuotaField(maxPerMinute)
      if (maxPerMinuteVal !== undefined) quota.maxRequestsPerMinute = maxPerMinuteVal
      const maxPerDayVal = parseQuotaField(maxPerDay)
      if (maxPerDayVal !== undefined) quota.maxRequestsPerDay = maxPerDayVal
      await updateProviderConfig(providerName.toLowerCase(), {
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(Object.keys(quota).length > 0 ? { quota } : {}),
      })
      setApiKey('')
      setBaseUrl('')
      setModel('')
      setMaxConcurrency('')
      setMaxPerMinute('')
      setMaxPerDay('')
      setSuccess(true)
      addToast({
        title: 'Provider updated',
        detail: `${providerName} configuration saved.`,
        tone: 'positive',
        dedupeKey: `settings:provider:${providerName}`,
        dedupeMode: 'replace',
      })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update provider')
    } finally {
      setSaving(false)
    }
  }

  const modelPlaceholder = modelHint ?? 'Use default model'

  const optionalFields = (
    <>
      <div>
        <label className="text-sm text-secondary" htmlFor={`model-${providerName}`}>Model (optional)</label>
        <input
          id={`model-${providerName}`}
          type="text"
          className="mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
          placeholder={modelPlaceholder}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>
      <div>
        <label className="text-sm text-secondary">Quota (optional)</label>
        <div className="mt-0.5 grid grid-cols-3 gap-1.5">
          <div>
            <input
              type="number"
              min="1"
              className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              placeholder="Concurrent"
              value={maxConcurrency}
              onChange={(e) => setMaxConcurrency(e.target.value)}
            />
            <p className="mt-1 text-sm text-secondary">Max concurrent</p>
          </div>
          <div>
            <input
              type="number"
              min="1"
              className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              placeholder="/min"
              value={maxPerMinute}
              onChange={(e) => setMaxPerMinute(e.target.value)}
            />
            <p className="mt-1 text-sm text-secondary">Per minute</p>
          </div>
          <div>
            <input
              type="number"
              min="1"
              className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              placeholder="/day"
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(e.target.value)}
            />
            <p className="mt-1 text-sm text-secondary">Per day</p>
          </div>
        </div>
      </div>
    </>
  )

  return (
    <div className={compact ? 'mt-3 space-y-3' : 'mt-3 rounded-lg border border-base bg-bg-elevated/40 p-3 space-y-2'}>
      {isLocal && (
        <div>
          <label className="text-sm text-secondary" htmlFor={`base-url-${providerName}`}>Base URL</label>
          <input
            id={`base-url-${providerName}`}
            type="text"
            className={`mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none${compact ? ' min-h-11' : ''}`}
            placeholder="http://localhost:11434/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <p className="mt-1 text-sm text-secondary">Use any OpenAI-compatible endpoint, such as Ollama or vLLM.</p>
        </div>
      )}
      <div>
        <div className="flex items-center justify-between">
          <label className="text-sm text-secondary" htmlFor={`api-key-${providerName}`}>
            API key{isLocal ? ' (optional)' : ''}
          </label>
          {keyUrl && (
            <a
              href={keyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-secondary hover:text-neutral underline underline-offset-2"
            >
              Get API key {'\u2197'}
            </a>
          )}
        </div>
        <input
          id={`api-key-${providerName}`}
          type="password"
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          className={`mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none${compact ? ' min-h-11' : ''}`}
          placeholder={isLocal ? 'Optional. Most local servers do not need one.' : `Enter ${providerName} API key`}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      {compact ? (
        <details>
          <summary className="cursor-pointer text-sm text-secondary py-3">Advanced provider settings</summary>
          <div className="space-y-3 pt-2">{optionalFields}</div>
        </details>
      ) : optionalFields}
      {error && <p role="alert" className="text-sm text-negative-400">{error}</p>}
      {success && <p className="text-sm text-positive-400">Provider updated.</p>}
      <Button type="button" size="sm" className={compact ? 'min-h-11' : undefined} disabled={!canSave || saving} onClick={asyncHandler(handleSave)}>
        {saving ? 'Saving...' : 'Save'}
      </Button>
    </div>
  )
}
