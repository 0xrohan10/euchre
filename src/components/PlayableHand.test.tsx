// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlayableHand } from './PlayableHand'
import type { Card } from '../game/card'

afterEach(cleanup)

const hearts: Card = { id: 'A-hearts', rank: 'A', suit: 'hearts' }
const clubs: Card = { id: 'K-clubs', rank: 'K', suit: 'clubs' }
const hand = [hearts, clubs]

function renderHand(overrides: Partial<React.ComponentProps<typeof PlayableHand>> = {}) {
  return render(
    <PlayableHand
      cards={hand}
      action="play"
      legalCardIds={new Set([hearts.id])}
      trump="hearts"
      leadSuit="hearts"
      onConfirm={vi.fn()}
      {...overrides}
    />,
  )
}

describe('PlayableHand', () => {
  it('selects a legal card and confirms it explicitly', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    renderHand({ onConfirm })

    const card = screen.getByRole('button', { name: /A of hearts.*Legal card/ })
    await user.click(card)
    expect(card.getAttribute('aria-pressed')).toBe('true')
    const confirm = screen.getByRole('button', { name: 'Play A of hearts' })
    expect((confirm as HTMLButtonElement).disabled).toBe(false)
    await user.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith(hearts)
  })

  it('keeps illegal cards disabled and labels them', () => {
    renderHand()
    const card = screen.getByRole('button', { name: /K of clubs.*Not legal to play/ })
    expect((card as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Play selected card' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('clears a selection when the card becomes stale or illegal', async () => {
    const user = userEvent.setup()
    const view = renderHand()
    await user.click(screen.getByRole('button', { name: /A of hearts.*Legal card/ }))
    view.rerender(
      <PlayableHand
        cards={[clubs]}
        action="play"
        legalCardIds={new Set([clubs.id])}
        onConfirm={vi.fn()}
      />,
    )
    expect(
      (screen.getByRole('button', { name: 'Play selected card' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('clears selection when the action changes', async () => {
    const user = userEvent.setup()
    const view = renderHand()
    await user.click(screen.getByRole('button', { name: /A of hearts.*Legal card/ }))
    view.rerender(
      <PlayableHand
        cards={hand}
        action="discard"
        legalCardIds={new Set([hearts.id])}
        onConfirm={vi.fn()}
      />,
    )
    expect(
      (screen.getByRole('button', { name: 'Discard selected card' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('guards selection and confirmation while pending or untrusted', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    renderHand({ onConfirm, pending: true })
    const pendingCard = screen.getByRole('button', { name: /A of hearts.*Legal card/ })
    expect((pendingCard as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Play selected card' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    cleanup()
    renderHand({ onConfirm, untrusted: true })
    const untrustedCard = screen.getByRole('button', { name: /A of hearts.*Legal card/ })
    await user.click(untrustedCard)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('keeps the full hand visible without action controls between card decisions', () => {
    renderHand({ action: null, legalCardIds: [] })

    expect(screen.getAllByRole('button', { name: /of/ })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /selected card/ })).toBeNull()
    expect(
      (screen.getByRole('button', { name: /A of hearts/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('suppresses duplicate confirmations while the command is in flight', async () => {
    let resolve!: () => void
    const onConfirm = vi.fn(() => {
      return new Promise<void>((complete) => {
        resolve = complete
      })
    })
    const user = userEvent.setup()
    renderHand({ onConfirm })

    await user.click(screen.getByRole('button', { name: /A of hearts.*Legal card/ }))
    const confirm = screen.getByRole('button', { name: 'Play A of hearts' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    resolve()
  })

  it('allows another confirmation after the command resolves', async () => {
    let complete!: () => void
    const onConfirm = vi.fn(() => {
      return new Promise<void>((resolve) => {
        complete = resolve
      })
    })
    const user = userEvent.setup()
    renderHand({ onConfirm })

    await user.click(screen.getByRole('button', { name: /A of hearts.*Legal card/ }))
    await user.click(screen.getByRole('button', { name: 'Play A of hearts' }))
    complete()
    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: /A of hearts.*Legal card/ }) as HTMLButtonElement)
          .disabled,
      ).toBe(false)
    })

    await user.click(screen.getByRole('button', { name: /A of hearts.*Legal card/ }))
    await user.click(screen.getByRole('button', { name: 'Play A of hearts' }))
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })

  it('allows another confirmation after the command rejects', async () => {
    let fail!: (error: Error) => void
    const onConfirm = vi.fn(() => {
      return new Promise<void>((_resolve, reject) => {
        fail = reject
      })
    })
    const user = userEvent.setup()
    renderHand({ onConfirm })

    await user.click(screen.getByRole('button', { name: /A of hearts.*Legal card/ }))
    await user.click(screen.getByRole('button', { name: 'Play A of hearts' }))
    fail(new Error('failed'))
    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: /A of hearts.*Legal card/ }) as HTMLButtonElement)
          .disabled,
      ).toBe(false)
    })

    await user.click(screen.getByRole('button', { name: /A of hearts.*Legal card/ }))
    await user.click(screen.getByRole('button', { name: 'Play A of hearts' }))
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })
})
