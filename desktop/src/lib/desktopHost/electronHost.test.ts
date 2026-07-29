import { describe, expect, it } from 'vitest'
import { createElectronHost } from './electronHost'
import { browserHost } from './browserHost'

describe('createElectronHost (pure-web stub)', () => {
  it('returns the browser host fallback', () => {
    const host = createElectronHost({
      invoke: async () => {
        throw new Error('unreachable')
      },
      subscribe: async () => () => undefined,
    })
    expect(host.kind).toBe(browserHost.kind)
    expect(host.isDesktop).toBe(false)
  })
})
