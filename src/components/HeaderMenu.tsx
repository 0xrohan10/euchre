import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export function HeaderMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const trayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        toggleRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    trayRef.current
      ?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      ?.focus()
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const close = () => {
    setOpen(false)
    toggleRef.current?.focus()
  }

  return (
    <div className="header-actions">
      <button
        ref={toggleRef}
        type="button"
        className="header-menu-toggle quiet-button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? 'Close menu' : 'Open menu'}
        onClick={() => {
          setOpen((current) => {
            return !current
          })
        }}
      >
        <span className="header-menu-icon" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </button>
      {open && (
        <div
          className="header-menu-scrim"
          onClick={() => {
            setOpen(false)
          }}
        />
      )}
      <div
        ref={trayRef}
        id={panelId}
        className={open ? 'header-actions-tray is-open' : 'header-actions-tray'}
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
        aria-label={open ? 'Menu' : undefined}
      >
        <div
          className="header-menu-items"
          onClick={(event) => {
            if (
              open &&
              event.target instanceof HTMLElement &&
              event.target.closest('button, a, [role="button"]')
            ) {
              setOpen(false)
            }
          }}
        >
          {children}
        </div>
        {open && (
          <button type="button" className="quiet-button header-menu-close" onClick={close}>
            Close
          </button>
        )}
      </div>
    </div>
  )
}
