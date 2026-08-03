import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A literal NUL in a source file makes git treat the whole file as binary, so
 * its diff disappears from review. One reached this package by writing the
 * separator byte itself where the escape sequence was meant, and the file
 * shipped to a pull request as an unreviewable blob.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

describe('source files are text', () => {
  it('contains no literal NUL byte', () => {
    const offenders = sourceFiles(new URL('../src', import.meta.url).pathname)
      .filter(path => readFileSync(path).includes(0))
    expect(offenders).toEqual([])
  })
})
