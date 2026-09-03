import { sqlite } from 'https://esm.town/v/std/sqlite/main.ts'
import { loadValTownConfig } from 'npm:@canonry/val-kit@0.2.0/config'
import { createRequestBoundDispatcher } from 'npm:@canonry/val-kit@0.2.0/jobs'
import { ValSqliteCheckStore } from 'npm:@canonry/val-kit@0.2.0/storage'
import { createGeminiValVisibilityProbe } from 'npm:@canonry/val-kit@0.2.0/visibility'
import { createValTownApp } from './src/app/app.ts'
import { createPublicCheckRunner } from './src/jobs/public-check.ts'
import type { CheckResult } from './src/runtime/check-result.ts'
import { createSiteHealthRunner } from './src/site-health/runner.ts'
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

const config = loadValTownConfig(Deno.env.toObject())
const store = new ValSqliteCheckStore<CheckResult>(sqlite)
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
