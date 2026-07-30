import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { CliLogoSwitcher } from './CliLogoSwitcher'
import { useAgentCliStore } from '../../stores/agentCliStore'
import { useUIStore } from '../../stores/uiStore'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import type { AgentCliListResponse, ProbeReport } from '../../api/agentCli'

const { listMock, setActiveApiMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  setActiveApiMock: vi.fn(),
}))

vi.mock('../../api/agentCli', async () => {
  const actual = await vi.importActual<typeof import('../../api/agentCli')>('../../api/agentCli')
  return {
    ...actual,
    agentCliApi: {
      ...actual.agentCliApi,
      list: listMock,
      setActive: setActiveApiMock,
    },
  }
})

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { fetchSessions: () => Promise<void> }) => unknown) =>
      selector({ fetchSessions: vi.fn(async () => {}) }),
    {
      getState: () => ({
        fetchSessions: vi.fn(async () => {}),
        setState: vi.fn(),
      }),
      setState: vi.fn(),
    },
  ),
}))

function tool(partial: Partial<ProbeReport> & Pick<ProbeReport, 'id' | 'displayName' | 'runnable'>): ProbeReport {
  return {
    installed: partial.runnable,
    localVersion: partial.runnable ? '1.0.0' : null,
    latestVersion: '1.0.0',
    installedButBroken: false,
    installs: [],
    hasConflict: false,
    maturity: 'full',
    npmPackage: null,
    upgradeAvailable: false,
    error: null,
    probedAt: new Date().toISOString(),
    ...partial,
  }
}

const sampleList: AgentCliListResponse = {
  tools: [
    tool({ id: 'claude-code', displayName: 'Claude Code', runnable: true }),
    tool({ id: 'grok', displayName: 'Grok', runnable: true }),
    tool({ id: 'kimi', displayName: 'Kimi', runnable: false }),
  ],
  activeId: 'claude-code',
  defaultId: 'claude-code',
  anyInstalled: true,
  anyRunnable: true,
  generatedAt: new Date().toISOString(),
}

describe('CliLogoSwitcher', () => {
  beforeEach(() => {
    listMock.mockReset()
    setActiveApiMock.mockReset()
    listMock.mockResolvedValue(sampleList)
    setActiveApiMock.mockResolvedValue({ activeId: 'grok' })
    useAgentCliStore.setState({
      activeId: 'claude-code',
      status: null,
      loading: false,
      error: null,
      focusInstallId: null,
    })
    useUIStore.setState({
      pendingSettingsTab: null,
      activeSettingsTab: 'providers',
      toasts: [],
    })
  })

  it('shows only the current CLI trigger with full name, not all logos at once', async () => {
    render(<CliLogoSwitcher />)
    await waitFor(() => {
      expect(screen.getByTestId('cli-logo-switcher-trigger')).toBeTruthy()
    })
    expect(screen.getByTestId('cli-logo-switcher-label').textContent).toBe('Claude Code')
    expect(screen.queryByTestId('cli-logo-switcher-menu')).toBeNull()
    expect(screen.queryByTestId('cli-logo-option-grok')).toBeNull()
  })

  it('opens a dropdown with logo+name options', async () => {
    render(<CliLogoSwitcher />)
    await waitFor(() => screen.getByTestId('cli-logo-switcher-trigger'))
    fireEvent.click(screen.getByTestId('cli-logo-switcher-trigger'))
    expect(screen.getByTestId('cli-logo-switcher-menu')).toBeTruthy()
    expect(screen.getByTestId('cli-logo-option-claude-code').textContent).toContain('Claude Code')
    expect(screen.getByTestId('cli-logo-option-grok').textContent).toContain('Grok')
    expect(screen.getByTestId('cli-logo-option-kimi').textContent).toContain('Kimi')
    expect(screen.getByTestId('cli-logo-option-kimi').textContent).toContain('未安装')
  })

  it('requires confirm before switching an installed CLI', async () => {
    render(<CliLogoSwitcher />)
    await waitFor(() => screen.getByTestId('cli-logo-switcher-trigger'))
    fireEvent.click(screen.getByTestId('cli-logo-switcher-trigger'))
    fireEvent.click(screen.getByTestId('cli-logo-option-grok'))

    expect(screen.getByText('确认切换 Agent CLI')).toBeTruthy()
    expect(setActiveApiMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('cli-logo-confirm'))
    await waitFor(() => {
      expect(setActiveApiMock).toHaveBeenCalledWith('grok')
    })
  })

  it('prompts install and opens system management for uninstalled CLI', async () => {
    const openTab = vi.spyOn(useTabStore.getState(), 'openTab').mockImplementation(() => {})

    render(<CliLogoSwitcher />)
    await waitFor(() => screen.getByTestId('cli-logo-switcher-trigger'))
    fireEvent.click(screen.getByTestId('cli-logo-switcher-trigger'))
    fireEvent.click(screen.getByTestId('cli-logo-option-kimi'))

    expect(screen.getByText('尚未安装此 Agent CLI')).toBeTruthy()
    fireEvent.click(screen.getByTestId('cli-logo-confirm'))

    await waitFor(() => {
      expect(useAgentCliStore.getState().focusInstallId).toBe('kimi')
      expect(useUIStore.getState().pendingSettingsTab).toBe('system')
      expect(useUIStore.getState().activeSettingsTab).toBe('system')
    })
    expect(openTab).toHaveBeenCalledWith(SETTINGS_TAB_ID, 'Settings', 'settings')
  })
})
