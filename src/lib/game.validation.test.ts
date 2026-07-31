import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES } from '../game/rules'
import { createRoomInput, submitCommandInput } from './game.validation'

describe('room creation compatibility', () => {
  it('accepts legacy creation requests without an operation ID', () => {
    expect(createRoomInput(DEFAULT_RULES)).toEqual({ rules: DEFAULT_RULES, legacy: true })
    expect(createRoomInput({ rules: DEFAULT_RULES })).toEqual({
      rules: DEFAULT_RULES,
      legacy: true,
    })
  })

  it('preserves new-client operation IDs', () => {
    expect(createRoomInput({ operationId: 'operation-1', rules: DEFAULT_RULES })).toEqual({
      operationId: 'operation-1',
      rules: DEFAULT_RULES,
      legacy: false,
    })
  })
})

describe('command response compatibility', () => {
  const command = {
    roomId: 'room-1',
    commandId: 'command-1',
    expectedVersion: 3,
    action: { type: 'pass' as const },
  }

  it('keeps unversioned commands on the legacy response protocol', () => {
    expect(submitCommandInput(command)).toEqual(command)
  })

  it('accepts the typed stale response protocol only at version 2', () => {
    expect(submitCommandInput({ ...command, responseVersion: 2 })).toEqual({
      ...command,
      responseVersion: 2,
    })
    expect(() => {
      return submitCommandInput({ ...command, responseVersion: 1 })
    }).toThrow('Invalid game command.')
  })
})
