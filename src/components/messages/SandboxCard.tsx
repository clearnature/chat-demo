import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { SandboxPart } from '../../services/chat/types.js'
import { resolveArtifactHtml } from '../../services/sandbox/canvasDocument.js'
import { openArtifactCanvas, useArtifactCanvas } from '../artifact/canvasState.js'
import { rerunPythonSandbox } from '../../services/sandbox/rerun.js'
import { useChatStore } from '../../services/chat/store.js'
import styles from './SandboxCard.module.css'

/**
 * 浏览器沙箱产物卡片：
 * - python：展示源码、stdout/stderr 与 matplotlib 图片；
 * - html：在 sandbox="allow-scripts" 的 iframe 中渲染（无同源权限），可重新运行。
 */
export const SandboxCard = ({ part }: { part: SandboxPart }) => {
  const t = useTranslate()
  const [showCode, setShowCode] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [issueCount, setIssueCount] = useState(0)
  const [rerunning, setRerunning] = useState(false)
  const autoOpened = useRef(false)
  const seenIssues = useRef<Set<string>>(new Set())
  const html = resolveArtifactHtml(part)
  const running = part.status === 'running'
  const failed = part.status === 'failed'

  // iframe 报错/console 回传：按产物 id 收集，供画布「控制台」与修复使用
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; artifactId?: string; level?: string; message?: string }
      if (data?.source !== 'ds-canvas' || data.artifactId !== part.id) {
        return
      }
      const line = data.message ?? ''
      useArtifactCanvas.getState().pushLog(part.id, data.level ?? 'console', line)
      if (line && !seenIssues.current.has(line)) {
        seenIssues.current.add(line)
        setIssueCount(seenIssues.current.size)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [part.id])

  // 新生成的 HTML 产物自动打开右侧画布；历史会话里的旧产物不自动弹出
  useEffect(() => {
    const fresh = Date.now() - part.createdAt < 120_000
    if (part.kind === 'html' && part.status === 'done' && html && fresh && !autoOpened.current) {
      autoOpened.current = true
      openArtifactCanvas(part)
    }
  }, [part, html])

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.badge}>
          {part.kind === 'python' ? t('sandboxPython') : t('sandboxArtifact')}
        </span>
        {part.title ? <span className={styles.title}>{part.title}</span> : null}
        {running ? <span className={styles.status}>{t('sandboxRunning')}</span> : null}
        {failed ? <span className={styles.failed}>{t('sandboxFailed')}</span> : null}
        <button type="button" className={styles.button} onClick={() => openArtifactCanvas(part)}>
          {issueCount > 0 ? `${t('canvasOpen')} (${issueCount})` : t('canvasOpen')}
        </button>
        <button type="button" className={styles.button} onClick={() => setShowCode((value) => !value)}>
          {t('sandboxCode')}
        </button>
        {part.kind === 'html' && html && !running ? (
          <button type="button" className={styles.button} onClick={() => setNonce((value) => value + 1)}>
            {t('sandboxRerun')}
          </button>
        ) : null}
        {part.kind === 'python' && !running ? (
          <button
            type="button"
            className={styles.button}
            disabled={rerunning}
            onClick={async () => {
              setRerunning(true)
              try {
                const updated = await rerunPythonSandbox(part, useChatStore.getState().activeId)
                useArtifactCanvas.getState().replaceArtifact(updated)
              } finally {
                setRerunning(false)
              }
            }}
          >
            {rerunning ? t('sandboxRunning') : t('sandboxRerun')}
          </button>
        ) : null}
      </div>

      {showCode ? <pre className={styles.code}>{part.code}</pre> : null}

      {part.kind === 'python' ? (
        <>
          {part.images && part.images.length > 0 ? (
            <div className={styles.images}>
              {part.images.map((image, index) => (
                <img key={index} className={styles.image} src={`data:image/png;base64,${image}`} alt={`plot-${index + 1}`} />
              ))}
            </div>
          ) : null}
          {part.output ? <pre className={styles.output}>{part.output}</pre> : null}
          {part.error ? <pre className={styles.error}>{part.error}</pre> : null}
        </>
      ) : null}

      {part.kind === 'html' && html ? (
        <iframe
          key={nonce}
          className={styles.frame}
          title={part.title ?? 'sandbox preview'}
          sandbox="allow-scripts"
          srcDoc={html}
        />
      ) : null}
      {part.kind === 'html' && part.error ? <pre className={styles.error}>{part.error}</pre> : null}
    </div>
  )
}
