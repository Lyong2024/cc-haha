import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { startMock, statusMock, logoutMock, activateProviderMock, fetchProvidersMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  statusMock: vi.fn(),
  logoutMock: vi.fn(),
  activateProviderMock: vi.fn(),
  fetchProvidersMock: vi.fn(),
}))

vi.mock('../api/hahaGrokOAuth', () => ({
  hahaGrokOAuthApi: {
    start: startMock,
    status: statusMock,
    logout: logoutMock,
  },
}))

vi.mock('./providerStore', () => ({
  useProviderStore: {
    getState: () => ({
      activeId: null as string | null,
      activateProvider: activateProviderMock,
      fetchProviders: fetchProvidersMock,
    }),
  },
}))

import { useHahaGrokOAuthStore } from './hahaGrokOAuthStore'

const initialState = useHahaGrokOAuthStore.getState()

describe('hahaGrokOAuthStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    startMock.mockReset()
    statusMock.mockReset()
    logoutMock.mockReset()
    activateProviderMock.mockReset().mockResolvedValue(undefined)
    fetchProvidersMock.mockReset().mockResolvedValue(undefined)
    useHahaGrokOAuthStore.setState({
      ...initialState,
      status: null,
      isPolling: false,
      isLoading: false,
      error: null,
    })
  })

  afterEach(() => {
    useHahaGrokOAuthStore.getState().stopPolling()
    useHahaGrokOAuthStore.setState(initialState)
    vi.useRealTimers()
  })

  it('returns the authorization URL without polling before the browser opens', async () => {
    startMock.mockResolvedValue({
      authorizeUrl: 'https://accounts.x.ai/oauth/authorize?state=grok-state',
      state: 'grok-state',
    })

    const result = await useHahaGrokOAuthStore.getState().login()

    expect(result.authorizeUrl).toContain('state=grok-state')
    expect(useHahaGrokOAuthStore.getState().isPolling).toBe(false)
  })

  it('stops polling after Grok OAuth becomes logged in and promotes Grok Official as default', async () => {
    statusMock
      .mockResolvedValueOnce({ loggedIn: false })
      .mockResolvedValueOnce({
        loggedIn: true,
        expiresAt: Date.now() + 60_000,
        email: 'grok@example.com',
      })

    useHahaGrokOAuthStore.getState().startPolling()
    await vi.advanceTimersByTimeAsync(4_000)
    // Flush the promoteGrokOfficialAsDefault promise after status settles.
    await Promise.resolve()
    await Promise.resolve()

    expect(useHahaGrokOAuthStore.getState().status).toMatchObject({
      loggedIn: true,
      email: 'grok@example.com',
    })
    expect(useHahaGrokOAuthStore.getState().isPolling).toBe(false)
    expect(activateProviderMock).toHaveBeenCalledWith('grok-official')
  })
})
