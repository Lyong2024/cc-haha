import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  syncAll: vi.fn(),
  refreshAll: vi.fn(),
  syncOne: vi.fn(),
  refreshOne: vi.fn(),
  setPreferred: vi.fn(),
  logout: vi.fn(),
  rename: vi.fn(),
  fetchProviders: vi.fn(),
  addToast: vi.fn(),
  fetchStatus: vi.fn(),
  login: vi.fn(),
  startPolling: vi.fn(),
}))

vi.mock('../../api/grokAccounts', () => ({
  grokAccountsApi: {
    list: mocks.list,
    syncAll: mocks.syncAll,
    refreshAll: mocks.refreshAll,
    syncOne: mocks.syncOne,
    refreshOne: mocks.refreshOne,
    setPreferred: mocks.setPreferred,
    logout: mocks.logout,
    rename: mocks.rename,
  },
}))

vi.mock('../../stores/providerStore', () => ({
  useProviderStore: (sel: (s: { fetchProviders: typeof mocks.fetchProviders; deleteProvider: () => void }) => unknown) =>
    sel({ fetchProviders: mocks.fetchProviders, deleteProvider: vi.fn() }),
}))

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (sel: (s: { addToast: typeof mocks.addToast }) => unknown) =>
    sel({ addToast: mocks.addToast }),
}))

vi.mock('../../stores/hahaGrokOAuthStore', () => ({
  useHahaGrokOAuthStore: (
    sel: (s: {
      fetchStatus: typeof mocks.fetchStatus
      login: typeof mocks.login
      startPolling: typeof mocks.startPolling
      isLoading: boolean
    }) => unknown,
  ) =>
    sel({
      fetchStatus: mocks.fetchStatus,
      login: mocks.login,
      startPolling: mocks.startPolling,
      isLoading: false,
    }),
}))

vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({
    shell: { open: vi.fn().mockResolvedValue(undefined) },
  }),
}))

vi.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}))

import { ProviderAccountPanel } from './ProviderAccountPanel'
import type { SavedProvider } from '../../types/provider'

const baseProvider: SavedProvider = {
  id: 'grok-official',
  presetId: 'grok-official',
  name: 'Grok Official',
  apiKey: '',
  baseUrl: 'https://cli-chat-proxy.grok.com/v1',
  apiFormat: 'openai_chat',
  models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
  createdAt: '2026-01-01T00:00:00.000Z',
  runtimeKind: 'grok_oauth',
}

const sampleAccounts = {
  preferredAccountId: null as string | null,
  strategy: 'round_robin' as const,
  accounts: [
    {
      id: 'acc-1',
      email: 'user@gmail.com',
      displayName: null,
      accountType: 'oauth/grok',
      enabled: true,
      createdAt: '2026-07-16T10:42:00.000Z',
      updatedAt: '2026-07-16T10:42:00.000Z',
      isPreferred: false,
      isActivePick: true,
      quotaSnapshot: {
        syncedAt: '2026-07-16T11:00:00.000Z',
        source: 'upstream' as const,
        status: 'ok' as const,
        used: 49299,
        remaining: 100701,
        limit: 150000,
        usagePercent: (49299 / 150000) * 100,
        weeklyRemaining: 3600,
        weeklyLimit: 5000,
        monthlyRemaining: 100701,
        monthlyLimit: 150000,
      },
      consecutiveFailures: 0,
      lastOkAt: null,
      lastErrorAt: null,
      hasRefreshToken: true,
      expiresAt: null,
    },
  ],
}

describe('ProviderAccountPanel (pool table)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.list.mockResolvedValue(sampleAccounts)
    mocks.syncAll.mockResolvedValue({ ...sampleAccounts, results: [{ id: 'acc-1', ok: true }] })
    mocks.refreshAll.mockResolvedValue({
      ...sampleAccounts,
      results: [{ id: 'acc-1', ok: true, refreshed: true }],
      refreshedCount: 1,
    })
    mocks.login.mockResolvedValue({ authorizeUrl: 'https://example.com/oauth' })
    mocks.setPreferred.mockImplementation(async (id: string, clear?: boolean) => ({
      ...sampleAccounts,
      preferredAccountId: clear ? null : id,
      strategy: clear ? 'round_robin' : 'preferred',
      accounts: sampleAccounts.accounts.map((a) => ({
        ...a,
        isPreferred: !clear && a.id === id,
      })),
    }))
    mocks.logout.mockResolvedValue({
      ok: true,
      remaining: 0,
      accounts: [],
      preferredAccountId: null,
    })
  })

  it('renders stacked weekly/monthly bars (label row above progress bar)', async () => {
    render(<ProviderAccountPanel provider={baseProvider} isActive officialOAuth />)

    await waitFor(() => {
      expect(screen.getByTestId('provider-account-table')).toBeInTheDocument()
    })
    expect(screen.getByText('user@gmail.com')).toBeInTheDocument()
    expect(screen.queryByText(/本账号池仅作用于/)).toBeNull()

    const weekly = await screen.findByTestId('quota-meter-weekly-acc-1')
    // stacked: flex-col, not flat inline with label
    expect(weekly.className).toMatch(/flex-col/)
    expect(weekly.textContent).toMatch(/周限/)
    expect(weekly.textContent).toMatch(/28%/)
    expect(weekly.querySelector('[role="progressbar"]')).toBeTruthy()

    const monthly = screen.getByTestId('quota-meter-monthly-acc-1')
    expect(monthly.className).toMatch(/flex-col/)
    expect(monthly.textContent).toMatch(/月限/)
    expect(monthly.textContent).toMatch(/49,299\/150,000/)
  })

  it('requires confirm before logout from ⋯ menu', async () => {
    render(<ProviderAccountPanel provider={baseProvider} isActive officialOAuth />)
    await waitFor(() => screen.getByTestId('account-menu-acc-1'))

    fireEvent.click(screen.getByTestId('account-menu-acc-1'))
    fireEvent.click(screen.getByTestId('account-logout-acc-1'))
    expect(screen.getByText('确认删除账号')).toBeInTheDocument()
    expect(mocks.logout).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('account-logout-confirm'))
    await waitFor(() => {
      expect(mocks.logout).toHaveBeenCalledWith('acc-1')
    })
  })

  it('sets preferred default account from ⋯ menu', async () => {
    render(<ProviderAccountPanel provider={baseProvider} isActive officialOAuth />)
    await waitFor(() => screen.getByTestId('account-menu-acc-1'))

    fireEvent.click(screen.getByTestId('account-menu-acc-1'))
    fireEvent.click(screen.getByText('设为默认'))
    await waitFor(() => {
      expect(mocks.setPreferred).toHaveBeenCalledWith('acc-1', false)
    })
  })

  it('auto-syncs all when autoSync enabled', async () => {
    render(<ProviderAccountPanel provider={baseProvider} isActive officialOAuth autoSync />)
    await waitFor(() => {
      expect(mocks.syncAll).toHaveBeenCalled()
    })
  })

  it('exposes toolbar: 额度同步 / 凭据刷新 / 账号接入', async () => {
    render(<ProviderAccountPanel provider={baseProvider} isActive officialOAuth />)
    await waitFor(() => screen.getByTestId('grok-pool-toolbar'))
    expect(screen.getByTestId('grok-pool-sync-quota')).toHaveTextContent('额度同步')
    expect(screen.getByTestId('grok-pool-refresh-creds')).toHaveTextContent('凭据刷新')
    expect(screen.getByTestId('grok-pool-connect')).toHaveTextContent('账号接入')

    fireEvent.click(screen.getByTestId('grok-pool-sync-quota'))
    await waitFor(() => expect(mocks.syncAll).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('grok-pool-refresh-creds'))
    await waitFor(() => expect(mocks.refreshAll).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('grok-pool-connect'))
    await waitFor(() => expect(mocks.login).toHaveBeenCalled())
  })
})
