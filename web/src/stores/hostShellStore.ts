import { create } from 'zustand'

type HostShellStore = {
  open: boolean
  height: number
  cwd: string | null
  toggle: (cwd?: string | null) => void
  openPanel: (cwd?: string | null) => void
  closePanel: () => void
  setHeight: (height: number) => void
  setCwd: (cwd: string | null) => void
}

const MIN_HEIGHT = 160
const MAX_HEIGHT = 560
const DEFAULT_HEIGHT = 280

export const useHostShellStore = create<HostShellStore>((set, get) => ({
  open: false,
  height: DEFAULT_HEIGHT,
  cwd: null,

  toggle: (cwd) => {
    if (get().open) {
      set({ open: false })
      return
    }
    set({ open: true, cwd: cwd ?? get().cwd })
  },

  openPanel: (cwd) => set({ open: true, cwd: cwd ?? get().cwd }),

  closePanel: () => set({ open: false }),

  setHeight: (height) =>
    set({
      height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(height))),
    }),

  setCwd: (cwd) => set({ cwd }),
}))

export const HOST_SHELL_MIN_HEIGHT = MIN_HEIGHT
export const HOST_SHELL_MAX_HEIGHT = MAX_HEIGHT
