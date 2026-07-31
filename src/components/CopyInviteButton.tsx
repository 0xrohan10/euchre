import { useId, useRef, useState } from 'react'

type CopyState = 'idle' | 'copying' | 'copied' | 'manual'

export function CopyInviteButton({
  path,
  label,
  copiedLabel = 'Copied',
  className = 'room-code',
}: {
  path: string
  label: string
  copiedLabel?: string
  className?: string
}) {
  const [state, setState] = useState<CopyState>('idle')
  const [value, setValue] = useState('')
  const fallbackId = useId()
  const fallbackRef = useRef<HTMLInputElement>(null)

  async function copy() {
    const inviteUrl = new URL(path, window.location.origin).href
    setValue(inviteUrl)
    setState('copying')
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable')
      }
      await navigator.clipboard.writeText(inviteUrl)
      setState('copied')
    } catch {
      setState('manual')
      requestAnimationFrame(() => {
        fallbackRef.current?.focus()
        fallbackRef.current?.select()
      })
    }
  }

  return (
    <div className="copy-invite">
      <button
        type="button"
        className={className}
        disabled={state === 'copying'}
        aria-describedby={state === 'manual' ? fallbackId : undefined}
        onClick={() => {
          return void copy()
        }}
      >
        {state === 'copying' ? 'Copying…' : state === 'copied' ? copiedLabel : label}
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {state === 'copied'
          ? 'Invite link copied to clipboard.'
          : state === 'manual'
            ? 'Copy failed. Use the selected invite link.'
            : ''}
      </span>
      {state === 'manual' && (
        <label className="manual-copy" id={fallbackId}>
          Copy this invite link
          <input
            ref={fallbackRef}
            readOnly
            value={value}
            onFocus={(event) => {
              event.currentTarget.select()
            }}
          />
        </label>
      )}
    </div>
  )
}
