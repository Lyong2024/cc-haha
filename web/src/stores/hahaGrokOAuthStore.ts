import { create } from 'zustand'
import { hahaGrokOAuthApi, type HahaGrokOAuthStatus } from '../api/hahaGrokOAuth'
import { GROK_OFFICIAL_PROVIDER_ID } from '../constants/grokOfficialProvider'

const POLL_INTERVAL_MS = 2_000

type HahaGrokOAuthState = {
  status: HahaGrokOAuthStatus | null
  isPolling: boolean
  isLoading: boolean
  error: string | null
  fetchStatus: () => Promise<void>
  login: () => Promise<{ authorizeUrl: string }>
  logout: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
}

async function promoteGrokOfficialAsDefault(): Promise<void> {
  // Lazy import keeps oauth store free of hard provider-store cycles at module load.
  const { useProviderStore } = await import('./providerStore')
  const store = useProviderStore.getState()
  if (store.activeId === GROK_OFFICIAL_PROVIDER_ID) {
    await store.fetchProviders()
    return
  }
  await store.activateProvider(GROK_OFFICIAL_PROVIDER_ID)
}

export const useHahaGrokOAuthStore = create<HahaGrokOAuthState>((set, get) => {
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  return {
    status: null,
    isPolling: false,
    isLoading: false,
    error: null,

    fetchStatus: async () => {
      try {
        set({ status: await hahaGrokOAuthApi.status(), error: null })
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    login: async () => {
      set({ isLoading: true, error: null })
      try {
        const result = await hahaGrokOAuthApi.start()
        set({ isLoading: false })
        return { authorizeUrl: result.authorizeUrl }
      } catch (err) {
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },

    logout: async () => {
      get().stopPolling()
      set({ isLoading: true, error: null })
      try {
        await hahaGrokOAuthApi.logout()
        set({ status: { loggedIn: false }, isLoading: false })
      } catch (err) {
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },

    startPolling: () => {
      if (pollTimer) return
      set({ isPolling: true })

      const scheduleNext = () => {
        pollTimer = setTimeout(async () => {
          pollTimer = null
          await get().fetchStatus()
          if (get().status?.loggedIn) {
            get().stopPolling()
            // Mirror backend activation so the green Default badge moves to Grok Official.
            await promoteGrokOfficialAsDefault().catch((err) => {
              console.warn('[hahaGrokOAuthStore] failed to activate Grok Official after login:', err)
            })
          } else if (get().isPolling) {
            scheduleNext()
          }
        }, POLL_INTERVAL_MS)
      }
      scheduleNext()
    },

    stopPolling: () => {
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      set({ isPolling: false })
    },
  }
})
