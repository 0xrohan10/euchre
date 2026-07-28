import { useEffect } from 'react'
import { useSensoryUI } from './ui/sensory-ui/config/provider'

const interactiveSelector = [
  'button',
  'a[href]',
  'input[type="button"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="submit"]',
  '[role="button"]',
  '[role="link"]',
].join(',')

export function InteractionSounds() {
  const { playSound } = useSensoryUI()

  useEffect(() => {
    const playInteraction = (event: MouseEvent) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return

      const control = event.target.closest(interactiveSelector)
      if (!control || control.matches(':disabled, [aria-disabled="true"]')) return

      playSound('interaction.subtle')
    }

    document.addEventListener('click', playInteraction)
    return () => document.removeEventListener('click', playInteraction)
  }, [playSound])

  return null
}
