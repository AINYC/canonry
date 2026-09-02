import { sqlite } from 'https://esm.town/v/std/sqlite/main.ts'
import { createValTownApp } from './src/app/app.ts'
import { loadValTownConfig } from './src/config/index.ts'
import { createPublicCheckRunner, createRequestBoundDispatcher } from './src/jobs/public-check.ts'
import { createSiteHealthRunner } from './src/site-health/runner.ts'
import { ValSqliteCheckStore } from './src/storage/val-sqlite.ts'
import {
  canonryDemoClientScript,
  canonryDemoStyles,
  canonryGlyph,
  canonryMark,
  createPublicCheckForm,
  emptyLandingViewModel,
  renderCanonryDemo,
  toCanonryDemoViewModel,
} from './src/ui/index.ts'
import { createGeminiValVisibilityProbe } from './src/visibility/gemini-probe.ts'

const config = loadValTownConfig()
const store = new ValSqliteCheckStore(sqlite)
await store.initialize()

const visibilityProbe = config.geminiApiKey
  ? createGeminiValVisibilityProbe({ apiKey: config.geminiApiKey, model: config.geminiModel ?? undefined })
  : null
const runner = createPublicCheckRunner({
  store,
  visibilityProbe,
  siteHealthRunner: createSiteHealthRunner(),
  ttlMs: config.checkTtlMs,
})

const form = createPublicCheckForm(config)

const app = createValTownApp({
  store,
  config,
  dispatcher: createRequestBoundDispatcher(runner),
  renderPage: (record) =>
    record
      ? renderCanonryDemo(toCanonryDemoViewModel(record, { form, title: 'AI Visibility Check' }))
      : renderCanonryDemo(emptyLandingViewModel(form)),
  assets: { styles: canonryDemoStyles, script: canonryDemoClientScript, mark: canonryMark, glyph: canonryGlyph },
})

export default app.fetch
