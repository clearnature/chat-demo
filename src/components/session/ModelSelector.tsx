import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './ModelSelector.module.css'

/** 顶部模型选择器：显示当前服务与模型，点击打开设置 */
export const ModelSelector = ({ className }: { className?: string }) => {
  const t = useTranslate()
  const provider = useSettings((state) => state.provider)
  const opencodeModel = useSettings((state) => state.opencodeModel)
  const label = provider === 'opencode' ? t('settingsProviderOpenCode') : t('settingsProviderDeepseek')
  const model = provider === 'opencode' ? opencodeModel : 'deepseek-flash'
  return (
    <button
      type="button"
      className={clsx(styles.selector, className)}
      onClick={() => openSettings('data')}
      title={t('settingsProviderDescription')}
    >
      <span className={styles.spark}>✦</span>
      <span className={styles.label}>{label}</span>
      <span className={styles.badge}>{model}</span>
    </button>
  )
}
