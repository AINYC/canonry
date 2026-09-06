import { expect, test } from 'vitest'
import {
  isNativeApiProviderName,
  normalizeProviderName,
  resolveAiVisibilityProviderReadiness,
} from '../src/lib/ai-visibility-provider-readiness.js'

test('transitional native IDs share the configured provider identity', () => {
  expect(normalizeProviderName(' Native:Gemini ')).toBe('gemini')
  expect(resolveAiVisibilityProviderReadiness({
    projectProviders: ['native:gemini'], configuredApiProviders: ['gemini'], cdpConfigured: false,
  })).toBe(true)
  expect(resolveAiVisibilityProviderReadiness({
    projectProviders: ['native:cdp:chatgpt'], configuredApiProviders: [], cdpConfigured: true,
  })).toBe(true)
})

test('text-only route selections never become automatic native sweeps', () => {
  expect(resolveAiVisibilityProviderReadiness({
    projectProviders: ['route:research'], configuredApiProviders: ['gemini', 'route:research'], cdpConfigured: true,
  })).toBe(false)
  expect(resolveAiVisibilityProviderReadiness({
    projectProviders: ['route:research'], configuredApiProviders: undefined, cdpConfigured: undefined,
  })).toBe(false)
})

test('automatic sweeps exclude generic routes from the API roster but retain CDP fallback', () => {
  expect(resolveAiVisibilityProviderReadiness({
    projectProviders: [], configuredApiProviders: ['route:research'], cdpConfigured: false,
  })).toBe(false)
  expect(resolveAiVisibilityProviderReadiness({
    projectProviders: [], configuredApiProviders: ['route:research'], cdpConfigured: undefined,
  })).toBeUndefined()
  expect(resolveAiVisibilityProviderReadiness({
    projectProviders: [], configuredApiProviders: ['route:research'], cdpConfigured: true,
  })).toBe(true)
})

test('dynamically registered native API names remain supported without a frozen provider list', () => {
  expect(isNativeApiProviderName('native:zai')).toBe(true)
  expect(isNativeApiProviderName('route:research')).toBe(false)
  expect(isNativeApiProviderName('native:cdp:chatgpt')).toBe(false)
  expect(resolveAiVisibilityProviderReadiness({
    projectProviders: ['native:zai'], configuredApiProviders: ['zai'], cdpConfigured: false,
  })).toBe(true)
})
