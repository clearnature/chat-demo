import { useTranslate } from '../../i18n/index.js'
import { openArtifactCanvas, useArtifactCanvas } from './canvasState.js'
import styles from './CanvasLauncher.module.css'

/** 关闭画布后，右下角悬浮按钮用于重新打开上一次的产物 */
export const CanvasLauncher = () => {
  const t = useTranslate()
  const open = useArtifactCanvas((state) => state.open)
  const lastArtifact = useArtifactCanvas((state) => state.lastArtifact)
  if (open || !lastArtifact) {
    return null
  }
  return (
    <button
      type="button"
      className={styles.launcher}
      onClick={() => openArtifactCanvas(lastArtifact)}
      title={t('canvasReopen')}
    >
      <span className={styles.icon}>🎨</span>
      {t('canvasReopen')}
    </button>
  )
}
