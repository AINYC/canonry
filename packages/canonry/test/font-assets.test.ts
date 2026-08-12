import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as Record<string, unknown>
}

describe('bundled dashboard fonts', () => {
  it('pins Geist build dependencies and publishes their license with the SPA assets', () => {
    const webPackage = readJson('apps/web/package.json')
    const canonryPackage = readJson('packages/canonry/package.json')
    const webDependencies = webPackage.dependencies as Record<string, string>
    const publishedFiles = canonryPackage.files as string[]
    const notices = fs.readFileSync(
      path.join(repoRoot, 'packages/canonry/THIRD_PARTY_NOTICES.md'),
      'utf8',
    )

    expect(webDependencies['@fontsource-variable/geist']).toBe('5.3.0')
    expect(webDependencies['@fontsource-variable/geist-mono']).toBe('5.3.0')
    expect(publishedFiles).toContain('assets/')
    expect(publishedFiles).toContain('THIRD_PARTY_NOTICES.md')
    expect(notices).toContain('Copyright 2024 The Geist Project Authors')
    expect(notices).toContain('GeistMono-Italic[wght].ttf')
    expect(notices).toContain('SIL OPEN FONT LICENSE Version 1.1')
  })
})
