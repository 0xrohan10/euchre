import { createFileRoute } from '@tanstack/react-router'
import { GameHistory } from '../components/GameHistory'
import '../App.css'

export const Route = createFileRoute('/history')({
  component: GameHistory,
})
