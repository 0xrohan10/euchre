// @vitest-environment jsdom
import { act, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockingDialog } from './BlockingDialog'
import { ConnectionStatus } from './ConnectionStatus'
import { CopyInviteButton } from './CopyInviteButton'
import { HeaderMenu } from './HeaderMenu'

afterEach(cleanup)

function DialogHarness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true)
        }}
      >
        Open
      </button>
      {open && (
        <BlockingDialog
          className="dialog"
          labelledBy="dialog-title"
          onEscape={() => {
            setOpen(false)
          }}
        >
          <h2 id="dialog-title">Decision</h2>
          <button type="button">First</button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
            }}
          >
            Last
          </button>
        </BlockingDialog>
      )}
    </>
  )
}

function CompetingDialogHarness({ onOutsideClick }: { onOutsideClick: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={onOutsideClick}>
        Background action
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(true)
        }}
      >
        Open blocking dialog
      </button>
      <HeaderMenu>
        <button type="button">Menu action</button>
      </HeaderMenu>
      {open && (
        <BlockingDialog
          className="dialog"
          labelledBy="blocking-title"
          onEscape={() => {
            setOpen(false)
          }}
        >
          <h2 id="blocking-title">Blocking decision</h2>
          <button type="button">Only action</button>
        </BlockingDialog>
      )}
    </>
  )
}

describe('interaction feedback components', () => {
  it('announces the connection state', () => {
    render(<ConnectionStatus connection={{ status: 'stale', snapshotTrusted: false }} />)
    expect(screen.getByRole('status').textContent).toContain('Connection stale, actions paused')
  })

  it('reports clipboard success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<CopyInviteButton path="/games/ABC123" label="Copy invite" />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy invite' }))

    expect((await screen.findByRole('button', { name: 'Copied' })).hasAttribute('disabled')).toBe(
      false,
    )
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/games/ABC123`)
    expect(screen.getByRole('status').textContent).toContain('Invite link copied to clipboard.')
  })

  it('offers and selects a manual clipboard fallback', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(<CopyInviteButton path="/games/ABC123" label="Copy invite" />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy invite' }))

    const fallback = await screen.findByRole('textbox', { name: 'Copy this invite link' })
    await waitFor(() => {
      expect(document.activeElement).toBe(fallback)
    })
    expect((fallback as HTMLInputElement).value).toBe(`${window.location.origin}/games/ABC123`)
    expect(screen.getByRole('status').textContent).toContain('Copy failed')
  })

  it('contains focus, closes on Escape, and restores focus', async () => {
    render(<DialogHarness />)
    const trigger = screen.getByRole('button', { name: 'Open' })
    trigger.focus()
    fireEvent.click(trigger)

    const first = screen.getByRole('button', { name: 'First' })
    const last = screen.getByRole('button', { name: 'Last' })
    expect(document.activeElement).toBe(first)

    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('server-renders and hydrates an initially open dialog before mounting its portal', async () => {
    const errors: unknown[] = []
    const originalError = console.error
    const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    const originalActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: ReturnType<typeof hydrateRoot> | undefined
    const dialog = (
      <BlockingDialog className="dialog" labelledBy="hydrated-dialog-title">
        <h2 id="hydrated-dialog-title">Hydrated decision</h2>
        <button type="button">Continue</button>
      </BlockingDialog>
    )

    try {
      container.innerHTML = renderToString(dialog)
      expect(container.querySelector('[data-blocking-dialog-placeholder]')).toBeTruthy()
      expect(container.querySelector('[role="dialog"]')).toBeNull()

      await act(async () => {
        root = hydrateRoot(container, dialog)
      })

      expect(screen.getByRole('dialog', { name: 'Hydrated decision' })).toBeTruthy()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Continue' }))
      expect(errors).toEqual([])
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount()
        })
      }
      console.error = originalError
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
      container.remove()
    }
  })

  it('blocks real outside clicks and redirects real tab focus escape', async () => {
    const user = userEvent.setup()
    const onOutsideClick = vi.fn()
    render(<CompetingDialogHarness onOutsideClick={onOutsideClick} />)

    await user.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeTruthy()
    const trigger = screen.getByRole('button', { name: 'Open blocking dialog' })
    await user.click(trigger)

    const action = screen.getByRole('button', { name: 'Only action' })
    const background = screen.getByRole('button', { name: 'Background action' })
    expect(document.activeElement).toBe(action)
    expect(screen.queryByRole('dialog', { name: 'Header menu' })).toBeNull()

    await user.click(background)
    expect(onOutsideClick).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(action)

    await user.tab()
    expect(document.activeElement).toBe(action)

    background.focus()
    expect(document.activeElement).toBe(action)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Blocking decision' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
