import { closeArtifactCanvas, useArtifactCanvas, type CanvasTab } from './canvasState.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore, sendMessage } from '../../services/chat/store.js'
import { setDraftText } from '../../services/chat/drafts.js'
import { showToast } from '../base/toastState.js'
import type { SandboxPart } from '../../services/chat/types.js'
import { resolveArtifactHtml } from '../../services/sandbox/canvasDocument.js'
import { rerunPythonSandbox } from '../../services/sandbox/rerun.js'
import styles from './ArtifactCanvas.module.css'

const TABS: { id: CanvasTab; label: 'canvasPreview' | 'canvasCode' | 'canvasConsole' }[] = [
  { id: 'preview', label: 'canvasPreview' },
  { id: 'code', label: 'canvasCode' },
  { id: 'console', label: 'canvasConsole' },
]

const DOWNLOAD_NAMES: Record<'html' | 'python', string> = {
  html: 'artifact.html',
  python: 'sandbox.py',
}

/** 文件下载（html / py） */
const downloadArtifact = (artifact: SandboxPart) => {
  const content =
    artifact.kind === 'html' ? artifact.html || artifact.code : artifact.code || ''
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = artifact.title
    ? `${artifact.title.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')}.${artifact.kind === 'html' ? 'html' : 'py'}`
    : DOWNLOAD_NAMES[artifact.kind]
  link.click()
  URL.revokeObjectURL(url)
}

/** 右侧画布抽屉：预览 / 代码 / 控制台，支持全屏、下载与「发给 AI 修复」 */
export const ArtifactCanvas = () => {
  const t = useTranslate()
  const open = useArtifactCanvas((state) => state.open)
  const artifact = useArtifactCanvas((state) => state.artifact)
  const tab = useArtifactCanvas((state) => state.tab)
  const fullscreen = useArtifactCanvas((state) => state.fullscreen)
  const setTab = useArtifactCanvas((state) => state.setTab)
  const toggleFullscreen = useArtifactCanvas((state) => state.toggleFullscreen)
  const clearLogs = useArtifactCanvas((state) => state.clearLogs)
  const logs = useArtifactCanvas((state) =>
    state.artifact ? state.logsByArtifact[state.artifact.id] ?? [] : []
  )
  const activeId = useChatStore((state) => state.activeId)
  const [nonce, setNonce] = useState(0)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const html = artifact ? resolveArtifactHtml(artifact) : undefined

  useEffect(() => {
    if (!open || !artifact) {
      return
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; artifactId?: string; level?: string; message?: string }
      if (data?.source !== 'ds-canvas' || data.artifactId !== artifact.id) {
        return
      }
      useArtifactCanvas.getState().pushLog(artifact.id, data.level ?? 'console', data.message ?? '')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [open, artifact])

  // 打开不同产物时重置 iframe，避免沿用旧 srcdoc 状态
  useEffect(() => {
    setNonce((value) => value + 1)
  }, [artifact?.id])

  const errorText = useMemo(() => logs.filter((line) => line.startsWith('[error]')).join('\n'), [logs])
  const hasIssues = errorText.length > 0 || artifact?.status === 'failed'

  if (!open) {
    return null
  }

  // 空画布：从右上角「打开画布」进入且还没有产物
  if (!artifact) {
    return (
      <>
        {!fullscreen ? <div className={styles.backdrop} onClick={closeArtifactCanvas} /> : null}
        <aside
          className={`${styles.canvas} ${fullscreen ? styles.fullscreen : ''}`}
          role="dialog"
          aria-label={t('canvasTitle')}
        >
          <header className={styles.header}>
            <div className={styles.titleWrap}>
              <span className={styles.icon}>🎨</span>
              <span className={styles.title}>{t('canvasTitle')}</span>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.action}
                onClick={toggleFullscreen}
              >
                {fullscreen ? t('canvasExitFullscreen') : t('canvasFullscreen')}
              </button>
              <button
                type="button"
                className={styles.close}
                onClick={closeArtifactCanvas}
                aria-label={t('canvasClose')}
              >
                ✕
              </button>
            </div>
          </header>
          <div className={styles.emptyState}>{t('canvasEmptyHint')}</div>
        </aside>
      </>
    )
  }

  const sendToAi = () => {
    const detail = logs.length > 0 ? logs.join('\n') : artifact.error || artifact.output || '(无输出)'
    const text = `我在前端画布运行代码时遇到问题，请修复并重新生成。\n\n错误/控制台输出：\n${detail}\n\n代码：\n\`\`\`${artifact.kind === 'python' ? 'python' : artifact.language ?? 'html'}\n${artifact.code}\n\`\`\``
    setDraftText(activeId, text)
    if (sendMessage(activeId)) {
      closeArtifactCanvas()
      showToast({ key: 'canvasSentToAi' })
    } else {
      showToast({ key: 'canvasSendFailed', type: 'error' })
    }
  }

  return (
    <>
      {!fullscreen ? <div className={styles.backdrop} onClick={closeArtifactCanvas} /> : null}
      <aside className={`${styles.canvas} ${fullscreen ? styles.fullscreen : ''}`} role="dialog" aria-label={t('canvasTitle')}>
        <header className={styles.header}>
          <div className={styles.titleWrap}>
            <span className={styles.icon}>{artifact.kind === 'python' ? '🐍' : '🧩'}</span>
            <span className={styles.title}>{artifact.title ?? (artifact.kind === 'python' ? t('sandboxPython') : t('sandboxArtifact'))}</span>
            {hasIssues ? <span className={styles.errorBadge}>{t('canvasHasIssues')}</span> : null}
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.action}
              onClick={async () => {
                if (artifact.kind === 'python') {
                  const updated = await rerunPythonSandbox(artifact, activeId)
                  useArtifactCanvas.getState().replaceArtifact(updated)
                  setTab('preview')
                } else {
                  setNonce((value) => value + 1)
                }
              }}
            >
              {t('sandboxRerun')}
            </button>
            <button type="button" className={styles.action} onClick={() => downloadArtifact(artifact)}>
              {t('canvasDownload')}
            </button>
            <button type="button" className={styles.action} onClick={toggleFullscreen}>
              {fullscreen ? t('canvasExitFullscreen') : t('canvasFullscreen')}
            </button>
            <button type="button" className={styles.close} onClick={closeArtifactCanvas} aria-label={t('canvasClose')}>
              ✕
            </button>
          </div>
        </header>

        <nav className={styles.tabs}>
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${styles.tab} ${tab === item.id ? styles.tabActive : ''}`}
              onClick={() => setTab(item.id)}
            >
              {t(item.label)}
            </button>
          ))}
        </nav>

        <div className={styles.body}>
          {tab === 'preview' ? (
            artifact.kind === 'html' && html ? (
              <iframe
                key={nonce}
                ref={frameRef}
                className={styles.frame}
                title={artifact.title ?? 'artifact preview'}
                sandbox="allow-scripts allow-pointer-lock allow-forms allow-popups"
                srcDoc={html}
              />
            ) : (
              <div className={styles.pythonPreview}>
                {artifact.images && artifact.images.length > 0 ? (
                  <div className={styles.images}>
                    {artifact.images.map((image, index) => (
                      <img key={index} className={styles.image} src={`data:image/png;base64,${image}`} alt={`plot-${index + 1}`} />
                    ))}
                  </div>
                ) : null}
                {artifact.output ? <pre className={styles.output}>{artifact.output}</pre> : null}
                {artifact.error ? <pre className={styles.error}>{artifact.error}</pre> : null}
              </div>
            )
          ) : null}
          {tab === 'code' ? <pre className={styles.code}>{artifact.code}</pre> : null}
          {tab === 'console' ? (
            <div className={styles.console}>
              <div className={styles.consoleToolbar}>
                <button type="button" className={styles.action} onClick={() => clearLogs()}>
                  {t('canvasClearConsole')}
                </button>
                <button type="button" className={styles.primary} disabled={!hasIssues} onClick={sendToAi}>
                  {t('canvasFixWithAi')}
                </button>
              </div>
              {logs.length > 0 ? (
                <pre className={styles.logs}>{logs.join('\n')}</pre>
              ) : artifact.kind === 'python' && (artifact.output || artifact.error) ? (
                <pre className={styles.logs}>{artifact.error || artifact.output}</pre>
              ) : (
                <p className={styles.empty}>{t('canvasNoConsole')}</p>
              )}
            </div>
          ) : null}
        </div>
      </aside>
    </>
  )
}
