import { sqlite } from 'https://esm.town/v/std/sqlite/main.ts'
import { loadValTownConfig } from 'npm:@canonry/val-kit@0.1.0/config'
import { createRequestBoundDispatcher } from 'npm:@canonry/val-kit@0.1.0/jobs'
import { createGeminiValPerceptionProbe } from 'npm:@canonry/val-kit@0.1.0/perception'
import { ValSqliteCheckStore } from 'npm:@canonry/val-kit@0.1.0/storage'
import { createValTownApp } from './src/app/app.ts'
import { createPerceptionCheckRunner } from './src/jobs/perception-check.ts'
import type { PerceptionCheckResult } from './src/runtime/check-result.ts'
import {
  brandPerceptionClientScript,
  brandPerceptionStyles,
  canonryGlyph,
  canonryMark,
  createPublicCheckForm,
  emptyLandingViewModel,
  PRODUCT_NAME,
  renderBrandPerception,
  toBrandPerceptionViewModel,
} from './src/ui/index.ts'

const config = loadValTownConfig(Deno.env.toObject())
// Named once. Every record this val reads back is typed from here; a cast on
// the result path downstream means the generic was dropped somewhere above it.
const store = new ValSqliteCheckStore<PerceptionCheckResult>(sqlite)
await store.initialize()

const perceptionProbe = config.geminiApiKey
  ? createGeminiValPerceptionProbe({ apiKey: config.geminiApiKey, model: config.geminiModel ?? undefined })
  : null
const runner = createPerceptionCheckRunner({ store, perceptionProbe, ttlMs: config.checkTtlMs })

const form = createPublicCheckForm(config)

const app = createValTownApp({
  store,
  config,
  dispatcher: createRequestBoundDispatcher(runner),
  renderPage: (record) =>
    record
      ? renderBrandPerception(toBrandPerceptionViewModel(record, { form, title: PRODUCT_NAME }))
      : renderBrandPerception(emptyLandingViewModel(form)),
  assets: {
    styles: brandPerceptionStyles,
    script: brandPerceptionClientScript,
    mark: canonryMark,
    glyph: canonryGlyph,
  },
})

export default app.fetch
