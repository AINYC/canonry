import { describe, expect, it } from 'vitest'
import { promptProviderApiKey } from '../src/commands/init.js'

function scriptedPrompt(answers: string[]): {
  promptFn: (question: string) => Promise<string>
  questions: string[]
} {
  const questions: string[] = []
  return {
    questions,
    promptFn: async question => {
      questions.push(question)
      return answers.shift() ?? ''
    },
  }
}

describe('provider key import from the environment', () => {
  it('offers an exported key and uses it on Enter (default yes)', async () => {
    const { promptFn, questions } = scriptedPrompt([''])
    const key = await promptProviderApiKey('Gemini', 'GEMINI_API_KEY', promptFn, {
      GEMINI_API_KEY: 'g-secret',
    } as NodeJS.ProcessEnv)

    expect(key).toBe('g-secret')
    // The prompt names the VARIABLE, never the value: a recorded terminal or
    // scrollback must not end up holding the secret because init echoed it.
    expect(questions).toHaveLength(1)
    expect(questions[0]).toContain('GEMINI_API_KEY')
    expect(questions[0]).not.toContain('g-secret')
  })

  it('falls through to the manual prompt on n', async () => {
    const { promptFn, questions } = scriptedPrompt(['n', 'typed-key'])
    const key = await promptProviderApiKey('OpenAI', 'OPENAI_API_KEY', promptFn, {
      OPENAI_API_KEY: 'env-key',
    } as NodeJS.ProcessEnv)

    expect(key).toBe('typed-key')
    expect(questions).toHaveLength(2)
  })

  it('skips the offer entirely when the variable is absent or blank', async () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: '   ' }]) {
      const { promptFn, questions } = scriptedPrompt(['typed'])
      const key = await promptProviderApiKey(
        'Anthropic',
        'ANTHROPIC_API_KEY',
        promptFn,
        env as NodeJS.ProcessEnv,
      )
      expect(key).toBe('typed')
      expect(questions).toHaveLength(1)
      expect(questions[0]).toContain('press Enter to skip')
    }
  })
})
