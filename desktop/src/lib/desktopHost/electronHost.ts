/**
 * Electron host removed on pure-web branch.
 * Kept as a typed stub so residual imports compile; runtime always uses browserHost.
 */

import type { DesktopHost } from './types'
import { browserHost } from './browserHost'

export type ElectronHostBridge = {
  invoke<T>(_channel: string, _payload?: unknown): Promise<T>
  getPathForFile?(file: File): string
  subscribe<T>(
    _channel: string,
    _handler: (payload: T) => void,
  ): Promise<() => void>
}

export function createElectronHost(_bridge: ElectronHostBridge): DesktopHost {
  return browserHost
}
