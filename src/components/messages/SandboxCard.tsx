import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { SandboxPart } from '../../services/chat/types.js'
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
  const running = part.status === 'running'
  const failed = part.status === 'failed'

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.badge}>
          {part.kind === 'python' ? t('sandboxPython') : t('sandboxArtifact')}
        </span>
        {part.title ? <span className={styles.title}>{part.title}</span> : null}
        {running ? <span className={styles.status}>{t('sandboxRunning')}</span> : null}
        {failed ? <span className={styles.failed}>{t('sandboxFailed')}</span> : null}
        <button type="button" className={styles.button} onClick={() => setShowCode((value) => !value)}>
          {t('sandboxCode')}
        </button>
        {part.kind === 'html' && part.html && !running ? (
          <button type="button" className={styles.button} onClick={() => setNonce((value) => value + 1)}>
            {t('sandboxRerun')}
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

      {part.kind === 'html' && part.html ? (
        <iframe
          key={nonce}
          className={styles.frame}
          title={part.title ?? 'sandbox preview'}
          sandbox="allow-scripts"
          srcDoc={part.html}
        />
      ) : null}
      {part.kind === 'html' && part.error ? <pre className={styles.error}>{part.error}</pre> : null}
    </div>
  )
}
