import { closeArtifactCanvas, useArtifactCanvas, type CanvasTab } from './canvasState.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore, sendMessage } from '../../services/chat/store.js'
import { setDraftText } from '../../services/chat/drafts.js'
import { showToast } from '../base/toastState.js'
import type { SandboxPart } from '../../services/chat/types.js'
import { buildCanvasSrcDoc, resolveArtifactHtml } from '../../services/sandbox/canvasDocument.js'
import { rerunPythonSandbox } from '../../services/sandbox/rerun.js'
import styles from './ArtifactCanvas.module.css'

const TABS: { id: CanvasTab; label: 'canvasPreview' | 'canvasCode' | 'canvasConsole' }[] = [
  { id: 'preview', label: 'canvasPreview' },
  { id: 'code', label: 'canvasCode' },
  { id: 'console', label: 'canvasConsole' },
]

const DEFAULT_CANVAS_CODE = `<!DOCTYPE html>
<html><head><style>
  html,body{margin:0;height:100%;overflow:hidden;background:radial-gradient(circle at 30% 20%,#2a1a52 0,#0b1020 55%,#070a14 100%);color:#e2e8f0;font-family:system-ui,sans-serif}
  .card{position:absolute;left:50%;top:18%;transform:translateX(-50%);text-align:center;padding:22px 34px;
    border:1px solid rgba(155,114,203,.35);border-radius:16px;background:rgba(20,26,44,.55);backdrop-filter:blur(8px)}
  .card h2{font-size:18px;margin:0 0 12px;letter-spacing:.08em}
  .fx{margin:8px 0;font-size:20px;color:#8be9fd;text-shadow:0 0 16px rgba(80,200,255,.8)}
  .chem{color:#ff9de2;text-shadow:0 0 16px rgba(255,120,220,.7)}
</style></head><body>
  <div class="card">
    <h2>Canvas + KaTeX 示例</h2>
    <div class="fx">$E = mc^2$</div>
    <div class="chem">$\\ce{H2O}$</div>
  </div>
  <canvas id="c" style="position:fixed;inset:0"></canvas>
  <script>
    const cv = document.getElementById('c'); const ctx = cv.getContext('2d');
    let W, H, parts = [];
    function resize(){ W=cv.width=innerWidth*devicePixelRatio; H=cv.height=innerHeight*devicePixelRatio;
      parts = Array.from({length: 110}, () => ({x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.6,vz:(Math.random()-.5)*.6,r:1+Math.random()*2})); }
    addEventListener('resize', resize); resize();
    function frame(){
      ctx.clearRect(0,0,W,H);
      for(const p of parts){ p.x+=p.vx*devicePixelRatio; p.y+=p.vz*devicePixelRatio;
        if(p.x<0||p.x>W)p.vx*=-1; if(p.y<0||p.y>H)p.vz*=-1;
        ctx.fillStyle='rgba(139,233,253,.85)'; ctx.beginPath(); ctx.arc(p.x,p.y,p.r*devicePixelRatio,0,7); ctx.fill(); }
      for(let i=0;i<parts.length;i++)for(let j=i+1;j<parts.length;j++){
        const a=parts[i],b=parts[j],d=Math.hypot(a.x-b.x,a.y-b.y);
        if(d<120*devicePixelRatio){ ctx.strokeStyle='rgba(155,114,203,'+(1-d/(120*devicePixelRatio))*0.45+')'; ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); }
      }
      requestAnimationFrame(frame);
    }
    frame();
  </script>
</body></html>`

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
  const [draftCode, setDraftCode] = useState(DEFAULT_CANVAS_CODE)
  const [draftLang, setDraftLang] = useState<'html' | 'python'>('html')
  const [runningDraft, setRunningDraft] = useState(false)
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

  // 空画布直接运行用户代码：HTML → iframe；Python → Pyodide
  const runDraft = async () => {
    const id = `draft-${Date.now()}`
    setRunningDraft(true)
    try {
      if (draftLang === 'python') {
        const part: SandboxPart = {
          type: 'sandbox',
          id,
          kind: 'python',
          title: 'Python 沙箱',
          code: draftCode,
          status: 'running',
          createdAt: Date.now(),
        }
        useArtifactCanvas.getState().openCanvas(part)
        const updated = await rerunPythonSandbox(part, null)
        useArtifactCanvas.getState().replaceArtifact(updated)
      } else {
        const part: SandboxPart = {
          type: 'sandbox',
          id,
          kind: 'html',
          title: '本地画布',
          code: draftCode,
          html: buildCanvasSrcDoc(draftCode, id),
          status: 'done',
          createdAt: Date.now(),
        }
        useArtifactCanvas.getState().openCanvas(part)
      }
    } finally {
      setRunningDraft(false)
    }
  }

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
          <div className={styles.emptyEditor}>
            <p className={styles.emptyHint}>{t('canvasEmptyHint')}</p>
            <div className={styles.emptyToolbar}>
              <div className={styles.langTabs}>
                <button
                  type="button"
                  className={`${styles.langTab} ${draftLang === 'html' ? styles.langTabActive : ''}`}
                  onClick={() => setDraftLang('html')}
                >
                  {t('canvasLangHtml')}
                </button>
                <button
                  type="button"
                  className={`${styles.langTab} ${draftLang === 'python' ? styles.langTabActive : ''}`}
                  onClick={() => setDraftLang('python')}
                >
                  {t('canvasLangPython')}
                </button>
              </div>
              <button type="button" className={styles.primary} disabled={runningDraft} onClick={() => void runDraft()}>
                {runningDraft ? t('sandboxRunning') : t('canvasRun')}
              </button>
            </div>
            <textarea
              className={styles.draftEditor}
              spellCheck={false}
              value={draftCode}
              onChange={(event) => setDraftCode(event.target.value)}
            />
          </div>
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
            <button
              type="button"
              className={styles.action}
              onClick={() => useArtifactCanvas.getState().openBlank()}
            >
              {t('canvasNew')}
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
