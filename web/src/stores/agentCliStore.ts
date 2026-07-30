import { create } from 'zustand'
import {
  agentCliApi,
  readLocalActiveAgentCli,
  writeLocalActiveAgentCli,
  type AgentCliId,
  type AgentCliListResponse,
  type AgentCliMaturity,
} from '../api/agentCli'

type AgentCliStore = {
  activeId: AgentCliId
  status: AgentCliListResponse | null
  loading: boolean
  error: string | null
  /**
   * When set, System Management → Agent CLI panel scrolls to this card and
   * pulses the install control so users know where to click.
   */
  focusInstallId: AgentCliId | null
  refresh: (skipLatest?: boolean) => Promise<AgentCliListResponse | null>
  setActive: (id: AgentCliId) => Promise<void>
  setFocusInstallId: (id: AgentCliId | null) => void
  maturityOf: (id?: AgentCliId | null) => AgentCliMaturity
  isClaudeActive: () => boolean
}

const DEFAULT_ID: AgentCliId = 'claude-code'

export const useAgentCliStore = create<AgentCliStore>((set, get) => ({
  activeId: readLocalActiveAgentCli() ?? DEFAULT_ID,
  status: null,
  loading: false,
  error: null,
  focusInstallId: null,

  refresh: async (skipLatest = true) => {
    set({ loading: true, error: null })
    try {
      const status = await agentCliApi.list(skipLatest)
      const local = readLocalActiveAgentCli()
      let activeId = status.activeId
      if (local && status.tools.some((t) => t.id === local && t.runnable)) {
        if (local !== status.activeId) {
          try {
            await agentCliApi.setActive(local)
            activeId = local
          } catch {
            writeLocalActiveAgentCli(status.activeId)
            activeId = status.activeId
          }
        } else {
          activeId = local
        }
      } else {
        writeLocalActiveAgentCli(status.activeId)
      }
      set({ status, activeId, loading: false })
      return { ...status, activeId }
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  },

  setActive: async (id) => {
    await agentCliApi.setActive(id)
    writeLocalActiveAgentCli(id)
    set((state) => ({
      activeId: id,
      status: state.status ? { ...state.status, activeId: id } : state.status,
    }))
  },

  setFocusInstallId: (id) => set({ focusInstallId: id }),

  maturityOf: (id) => {
    const target = id ?? get().activeId
    return get().status?.tools.find((t) => t.id === target)?.maturity ?? 'manage-only'
  },

  isClaudeActive: () => get().activeId === 'claude-code',
}))
