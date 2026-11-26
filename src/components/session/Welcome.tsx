import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { setDraftText } from '../../services/chat/drafts.js'
import { sendMessage } from '../../services/chat/store.js'
import { showToast } from '../base/toastState.js'
import { MobileHeader } from './MobileHeader.js'
import { ChatTopActions } from './ChatTopActions.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
const DEMOS: { title: string; tag: string; prompt: string }[] = [
  {
    title: '3D 旋转立方体',
    tag: 'Three.js · 鼠标拖拽',
    prompt:
      '用 render_frontend_artifact 做一个 Three.js 3D 旋转立方体，支持鼠标拖拽旋转和滚轮缩放，页面上显示标题「3D 场景」。',
  },
  {
    title: '双摆混沌动画',
    tag: '物理仿真 · KaTeX 方程',
    prompt:
      '用 render_frontend_artifact 做一个双摆（double pendulum）物理动画，用 KaTeX 渲染运动方程 $\\ddot{\\theta}_1$ 与 $\\ddot{\\theta}_2$，支持鼠标拖拽改变初始角度。',
  },
  {
    title: 'Python 科学绘图',
    tag: 'Pyodide · Matplotlib',
    prompt:
      '用 python_sandbox 用 matplotlib 画出阻尼振动的位移-时间曲线，英文标签，并打印峰值和衰减率。',
  },
  {
    title: '数理化公式画布',
    tag: 'Canvas · KaTeX + mhchem',
    prompt:
      '用 render_frontend_artifact 写一个 Canvas 粒子动画，并用 KaTeX/mhchem 显示 $E=mc^2$ 与 \\ce{H2O}，带深色渐变背景。',
  },
]

export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const runDemo = (prompt: string) => {
    setDraftText(null, prompt)
    if (!sendMessage(null)) {
      showToast({ key: 'canvasSendFailed', type: 'error' })
    }
  }
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.topbar}>
        <ChatTopActions />
      </div>
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        <div className={styles.demos}>
          {DEMOS.map((demo) => (
            <button
              key={demo.title}
              type="button"
              className={styles.demoCard}
              onClick={() => runDemo(demo.prompt)}
            >
              <span className={styles.demoTitle}>{demo.title}</span>
              <span className={styles.demoTag}>{demo.tag}</span>
            </button>
          ))}
        </div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
