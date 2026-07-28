import { useEffect, useRef } from 'react'
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
  const playSoundRef = useRef(playSound)
  playSoundRef.current = playSound

  useEffect(() => {
    const playInteraction = (event: MouseEvent) => {
      if (!event.isTrusted || !(event.target instanceof Element)) {
        return
      }

      const control = event.target.closest(interactiveSelector)
      if (!control || control.matches(':disabled, [aria-disabled="true"]')) {
        return
      }

      playSoundRef.current('interaction.subtle')
    }

    document.addEventListener('click', playInteraction)
    return () => {
      return document.removeEventListener('click', playInteraction)
    }
  }, [])

  return null
}
