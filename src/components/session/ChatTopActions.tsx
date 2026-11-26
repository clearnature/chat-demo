import { useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import type { SandboxPart } from '../../services/chat/types.js'
import { openArtifactCanvas, useArtifactCanvas } from '../artifact/canvasState.js'
import styles from './ChatTopActions.module.css'

/** 从当前会话里收集模型生成的文件（画布产物） */
const collectGeneratedFiles = (session: { messages: { role: string; blocks?: { type: string }[] }[] } | undefined): SandboxPart[] => {
  if (!session) {
    return []
  }
  const found: SandboxPart[] = []
  for (const message of session.messages) {
    if (message.role !== 'assistant' || !message.blocks) {
      continue
    }
    for (const block of message.blocks) {
      if (block.type === 'sandbox') {
        found.push(block as SandboxPart)
      }
    }
  }
  return found.reverse()
}

/** 右上角：打开对话生成的文件 / 打开画布（Gemini Canvas 风格入口） */
export const ChatTopActions = () => {
  const t = useTranslate()
  const [filesOpen, setFilesOpen] = useState(false)
  const session = useChatStore((state) =>
    state.activeId !== null ? state.sessionCache[state.activeId] : undefined
  )
  const lastArtifact = useArtifactCanvas((state) => state.lastArtifact)
  const canvasOpen = useArtifactCanvas((state) => state.open)
  const files = useMemo(() => collectGeneratedFiles(session), [session])

  const openCanvas = () => {
    if (lastArtifact) {
      openArtifactCanvas(lastArtifact)
    } else {
      useArtifactCanvas.getState().openBlank()
    }
  }

  return (
    <div className={styles.actions}>
      <div className={styles.menuWrap}>
        <button
          type="button"
          className={styles.action}
          onClick={() => setFilesOpen((value) => !value)}
          title={t('topOpenFile')}
        >
          <span className={styles.icon}>📂</span>
          {t('topOpenFile')}
        </button>
        {filesOpen ? (
          <div className={styles.menu} role="menu">
            {files.length === 0 ? (
              <div className={styles.menuEmpty}>{t('topNoGeneratedFiles')}</div>
            ) : (
              files.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => {
                    openArtifactCanvas(file)
                    setFilesOpen(false)
                  }}
                >
                  <span className={styles.menuIcon}>{file.kind === 'python' ? '🐍' : '🧩'}</span>
                  <span className={styles.menuText}>
                    <span className={styles.menuTitle}>
                      {file.title || (file.kind === 'python' ? t('sandboxPython') : t('sandboxArtifact'))}
                    </span>
                    <span className={styles.menuMeta}>
                      {file.kind === 'python' ? 'Python' : file.language ?? 'HTML'}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.action}
        onClick={openCanvas}
        disabled={canvasOpen}
        title={t('topOpenCanvas')}
      >
        <span className={styles.icon}>🎨</span>
        {t('topOpenCanvas')}
      </button>
    </div>
  )
}
