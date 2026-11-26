import { useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { addDraftFiles } from '../../services/chat/drafts.js'
import { useChatStore } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { openArtifactCanvas, useArtifactCanvas } from '../artifact/canvasState.js'
import { showToast } from '../base/toastState.js'
import styles from './ChatTopActions.module.css'

/** 右上角：打开文件 / 打开画布（Gemini Canvas 风格入口） */
export const ChatTopActions = () => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const activeId = useChatStore((state) => state.activeId)
  const lastArtifact = useArtifactCanvas((state) => state.lastArtifact)
  const canvasOpen = useArtifactCanvas((state) => state.open)

  const pickFiles = () => inputRef.current?.click()

  const onFiles = (files: FileList | null) => {
    if (!files || files.length === 0) {
      return
    }
    const error = addDraftFiles(activeId, Array.from(files), useSettings.getState().apiKey ?? '')
    if (error) {
      showToast(error)
    }
  }

  const openCanvas = () => {
    if (lastArtifact) {
      openArtifactCanvas(lastArtifact)
    } else {
      useArtifactCanvas.getState().openBlank()
    }
  }

  return (
    <div className={styles.actions}>
      <input
        ref={inputRef}
        type="file"
        multiple
        className={styles.fileInput}
        onChange={(event) => {
          onFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <button type="button" className={styles.action} onClick={pickFiles} title={t('topOpenFile')}>
        <span className={styles.icon}>📂</span>
        {t('topOpenFile')}
      </button>
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
