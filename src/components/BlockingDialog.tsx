import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function BlockingDialog({
  children,
  className,
  labelledBy,
  describedBy,
  onEscape,
  onBackdropClick,
  onClick,
}: {
  children: ReactNode
  className: string
  labelledBy: string
  describedBy?: string
  onEscape?: () => void
  onBackdropClick?: () => void
  onClick?: MouseEventHandler<HTMLElement>
}) {
  const [mounted, setMounted] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)
  const handleEscape = useEffectEvent(() => {
    onEscape?.()
  })

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) {
      return
    }
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current

    document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach((openDialog) => {
      if (typeof openDialog.close === 'function') {
        openDialog.close()
      } else {
        openDialog.removeAttribute('open')
      }
    })
    window.dispatchEvent(new Event('blocking-dialog-open'))
    const focusable = dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []
    ;(focusable[0] ?? dialog)?.focus()

    const keepFocusInside = (event: FocusEvent) => {
      if (!dialog?.contains(event.target as Node)) {
        const controls = dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []
        ;(controls[0] ?? dialog)?.focus()
      }
    }

    const blockOutsidePointer = (event: Event) => {
      if (
        dialog &&
        !dialog.contains(event.target as Node) &&
        event.target !== dialog.parentElement
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        handleEscape()
        return
      }
      if (event.key !== 'Tab' || !dialog) {
        return
      }
      const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (controls.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = controls[0]
      const last = controls.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', keepFocusInside)
    document.addEventListener('pointerdown', blockOutsidePointer, true)
    document.addEventListener('click', blockOutsidePointer, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', keepFocusInside)
      document.removeEventListener('pointerdown', blockOutsidePointer, true)
      document.removeEventListener('click', blockOutsidePointer, true)
      if (
        returnFocus?.isConnected &&
        !returnFocus.matches(':disabled') &&
        !returnFocus.closest('[inert]')
      ) {
        returnFocus.focus()
      }
    }
  }, [mounted])

  if (!mounted) {
    return <span hidden data-blocking-dialog-placeholder="" />
  }

  return createPortal(
    <div
      className="blocking-dialog-layer"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onBackdropClick?.()
        }
      }}
    >
      <section
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onClick={onClick}
      >
        {children}
      </section>
    </div>,
    document.body,
  )
}
