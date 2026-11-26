import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import styles from './SessionDeleteConfirm.module.css'

export type ConfirmAnchor = { left: number; top: number; right: number; bottom: number }

/** 会话删除确认：锚定在会话项旁边，不再使用屏幕中央 Modal */
export const SessionDeleteConfirm = ({
  anchor,
  pending,
  onCancel,
  onConfirm,
}: {
  anchor: ConfirmAnchor
  pending: boolean
  onCancel: () => void
  onConfirm: () => void
}) => {
  const t = useTranslate()
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) {
      return
    }
    const width = el.offsetWidth
    const height = el.offsetHeight
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))
    const below = anchor.bottom + 6
    const top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 6) : below
    setPos({ left, top })
  }, [anchor])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onCancel()
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onCancel])

  return createPortal(
    <div
      ref={ref}
      className={styles.popover}
      role="alertdialog"
      aria-label={t('deleteSessionModalContentTitle')}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <div className={styles.title}>{t('deleteSessionModalContentTitle')}</div>
      <p className={styles.desc}>{t('deleteSessionWithFilesDescription')}</p>
      <div className={styles.actions}>
        <Button variant="outlined" size="s" disabled={pending} onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button variant="danger" size="s" disabled={pending} onClick={onConfirm}>
          {t('delete')}
        </Button>
      </div>
    </div>,
    document.body
  )
}
