import { create } from 'zustand'
import type { SandboxPart } from '../../services/chat/types.js'

export type CanvasTab = 'preview' | 'code' | 'console'

type CanvasState = {
  open: boolean
  artifact: SandboxPart | null
  /** 最近一次打开的产物：关闭画布后仍可从悬浮按钮重新打开 */
  lastArtifact: SandboxPart | null
  tab: CanvasTab
  fullscreen: boolean
  /** 按产物 id 收集 iframe 回传的报错/console 信息（关闭画布后仍保留） */
  logsByArtifact: Record<string, string[]>
  openCanvas: (artifact: SandboxPart) => void
  closeCanvas: () => void
  replaceArtifact: (artifact: SandboxPart) => void
  setTab: (tab: CanvasTab) => void
  toggleFullscreen: () => void
  pushLog: (artifactId: string, level: string, message: string) => void
  clearLogs: () => void
}

export const useArtifactCanvas = create<CanvasState>((set, get) => ({
  open: false,
  artifact: null,
  lastArtifact: null,
  tab: 'preview',
  fullscreen: false,
  logsByArtifact: {},
  openCanvas: (artifact) => set({ open: true, artifact, lastArtifact: artifact, tab: 'preview' }),
  closeCanvas: () => set({ open: false, artifact: null, fullscreen: false }),
  replaceArtifact: (artifact) =>
    set((state) => ({
      artifact: state.artifact && state.artifact.id === artifact.id ? artifact : state.artifact,
      lastArtifact:
        state.lastArtifact && state.lastArtifact.id === artifact.id ? artifact : state.lastArtifact,
    })),
  setTab: (tab) => set({ tab }),
  toggleFullscreen: () => set((state) => ({ fullscreen: !state.fullscreen })),
  pushLog: (artifactId, level, message) =>
    set((state) => {
      const line = `[${level}] ${message}`
      const previous = state.logsByArtifact[artifactId] ?? []
      if (previous.includes(line)) {
        return state
      }
      return {
        logsByArtifact: {
          ...state.logsByArtifact,
          [artifactId]: [...previous, line].slice(-100),
        },
      }
    }),
  clearLogs: () => {
    const { artifact, logsByArtifact } = get()
    if (!artifact) {
      return
    }
    const next = Object.fromEntries(
      Object.entries(logsByArtifact).filter(([id]) => id !== artifact.id)
    )
    set({ logsByArtifact: next })
  },
}))

export const openArtifactCanvas = (artifact: SandboxPart) =>
  useArtifactCanvas.getState().openCanvas(artifact)
export const closeArtifactCanvas = () => useArtifactCanvas.getState().closeCanvas()
