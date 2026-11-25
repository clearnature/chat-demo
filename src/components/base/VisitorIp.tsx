import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import styles from './VisitorIp.module.css'

type IpResponse = { ip?: unknown }

/**
 * 页脚显示当前访客的出口 IP。
 * 静态站点无法在浏览器侧得知自身公网 IP，因此由同源接口 /api/ip 返回
 *（nginx 用 $remote_addr 生成），失败时整条页脚隐藏，不影响页面。
 */
export const VisitorIp = () => {
  const t = useTranslate()
  const [ip, setIp] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch('/api/ip', {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const data = (await response.json()) as IpResponse
        if (typeof data.ip === 'string' && data.ip.length > 0) {
          setIp(data.ip)
        } else {
          setFailed(true)
        }
      } catch {
        if (!controller.signal.aborted) {
          setFailed(true)
        }
      }
    })()
    return () => controller.abort()
  }, [])

  if (failed) {
    return null
  }

  return (
    <div className={styles.footer} role="contentinfo">
      <span className={styles.label}>{t('visitorIpLabel')}</span>
      <span className={styles.value} title={ip ?? undefined}>
        {ip ?? '…'}
      </span>
    </div>
  )
}
