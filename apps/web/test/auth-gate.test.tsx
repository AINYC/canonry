import { test, expect, onTestFinished, describe, vi, afterEach } from 'vitest'

import React from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'

import { handleAuthExpired } from '../src/api.js'
import { AuthGate } from '../src/components/auth/AuthGate.js'
import { mockFetch as installMockFetch, jsonResponse } from './mock-fetch.js'

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const restore = installMockFetch(handler)
  onTestFinished(restore)
}

const API_SESSION = '/api/v1/session'

const dashboardProject = {
  id: 'project_auth_gate',
  name: 'auth-gate-project',
  displayName: 'Auth gate project',
  canonicalDomain: 'auth-gate.example',
  ownedDomains: [],
  aliases: [],
  country: 'US',
  language: 'en',
  tags: [],
  labels: {},
  providers: [],
  providerModels: {},
  locations: [],
  defaultLocation: null,
  measurement: { marketingHosts: [], brandTerms: [], leadEventNames: [] },
  autoExtractBacklinks: false,
  configSource: 'api',
  configRevision: 1,
}

function dashboardFallback(urlStr: string) {
  if (/\/api\/v1\/projects(?:\?|$)/.test(urlStr)) return jsonResponse([dashboardProject])
  if (urlStr.includes('/projects/') && urlStr.endsWith('/overview')) return jsonResponse({}, 404)
  if (urlStr.includes('/runs')) return jsonResponse([])
  return jsonResponse({})
}

afterEach(() => {
  cleanup()
})

describe('AuthGate', () => {
  describe('initial auth state', () => {
    test('renders login form when session is unauthenticated', async () => {
      mockFetch((url) => {
        if (String(url).includes(API_SESSION)) return jsonResponse({ authenticated: false })
        return jsonResponse({})
      })

      render(<AuthGate />)
      expect(await screen.findByText('Sign in to Canonry')).toBeTruthy()
    })

    test('renders setup form when session returns setupRequired', async () => {
      mockFetch((url) => {
        if (String(url).includes(API_SESSION)) return jsonResponse({ authenticated: false, setupRequired: true })
        return jsonResponse({})
      })

      render(<AuthGate />)
      expect(await screen.findByText('Create a dashboard password')).toBeTruthy()
      expect(screen.getByText('Choose a password to protect the Canonry dashboard.')).toBeTruthy()
      expect(screen.queryByText(/future visits/i)).toBeNull()
    })

    test('renders dashboard when session is authenticated', async () => {
      mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) return jsonResponse({ authenticated: true })
        return dashboardFallback(urlStr)
      })

      render(<AuthGate />)
      expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy()
    })

    test('shows connecting state while session check is pending', async () => {
      let resolveSession: (value: Response) => void
      mockFetch((url) => {
        if (String(url).includes(API_SESSION)) {
          return new Promise((resolve) => { resolveSession = resolve })
        }
        return jsonResponse({})
      })

      render(<AuthGate />)
      expect(screen.getByText('Connecting to Canonry…')).toBeTruthy()

      await act(async () => {
        resolveSession!(jsonResponse({ authenticated: false }))
      })

      expect(await screen.findByText('Sign in to Canonry')).toBeTruthy()
    })
  })

  describe('auth expiry callback', () => {
    test('transitions to login immediately when handleAuthExpired fires', async () => {
      mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) return jsonResponse({ authenticated: true })
        return dashboardFallback(urlStr)
      })

      render(<AuthGate />)
      expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy()

      await act(async () => {
        handleAuthExpired()
      })

      expect(await screen.findByText('Sign in to Canonry')).toBeTruthy()
    })

    test('shows session-expired message when bounced back to login', async () => {
      mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) return jsonResponse({ authenticated: true })
        return dashboardFallback(urlStr)
      })

      render(<AuthGate />)
      expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy()

      await act(async () => {
        handleAuthExpired()
      })

      expect(await screen.findByText(/Your session expired/i)).toBeTruthy()
    })
  })

  describe('periodic session re-check', () => {
    test('transitions to login when interval check returns unauthenticated', async () => {
      // Use a mutable object for session so we can change responses mid-test
      const sessionState = { authenticated: true, setupRequired: false }

      mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) return jsonResponse(sessionState)
        return dashboardFallback(urlStr)
      })

      vi.useFakeTimers({ shouldAdvanceTime: true })

      render(<AuthGate />)
      expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy()

      // Change the session state to unauthenticated
      sessionState.authenticated = false

      // Advance time past the re-check interval (60s)
      await act(async () => {
        vi.advanceTimersByTime(65_000)
      })

      expect(await screen.findByText('Sign in to Canonry')).toBeTruthy()

      vi.useRealTimers()
    })

    test('stays on dashboard when interval check fails with a network error', async () => {
      // Transient network errors during the periodic re-check must NOT log
      // the user out — they'll be kicked by the apiFetch 401 interceptor
      // the next time a real request fails. A brief Wi-Fi blip shouldn't
      // strand the user on a login form.
      const sessionState = { authenticated: true, setupRequired: false }
      let shouldThrow = false

      mockFetch((url) => {
        const urlStr = String(url)
        if (urlStr.includes(API_SESSION)) {
          if (shouldThrow) throw new Error('Network error')
          return jsonResponse(sessionState)
        }
        return dashboardFallback(urlStr)
      })

      vi.useFakeTimers({ shouldAdvanceTime: true })

      render(<AuthGate />)
      expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeTruthy()

      shouldThrow = true

      await act(async () => {
        vi.advanceTimersByTime(65_000)
      })

      // User is still on the dashboard, not kicked to login
      expect(screen.queryByText('Sign in to Canonry')).toBeNull()
      expect(screen.getAllByText('Portfolio').length).toBeGreaterThan(0)

      vi.useRealTimers()
    })
  })
})
