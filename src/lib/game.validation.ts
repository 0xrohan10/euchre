import { Schema } from 'effect'
import { SUITS } from '../game/card'

const NonEmptyText = Schema.NonEmptyString

export const GameRulesSchema = Schema.Struct({
  stickDealer: Schema.Boolean,
  requireNaturalTrump: Schema.Boolean,
  allowAloneWhenOrderingPartner: Schema.Boolean,
  allowFarmersHand: Schema.Boolean,
})

export const CreateRoomInputSchema = Schema.Struct({
  operationId: Schema.optionalKey(NonEmptyText),
  rules: GameRulesSchema,
})

const CompatibleCreateRoomInputSchema = Schema.Union([CreateRoomInputSchema, GameRulesSchema])

export const RoomCreationInputSchema = Schema.Struct({
  operationId: NonEmptyText,
  kind: Schema.Literals(['multiplayer', 'single-player']),
})

export const RoomIdInputSchema = Schema.Struct({
  roomId: NonEmptyText,
})

export const JoinRoomInputSchema = Schema.Struct({
  code: NonEmptyText,
})

export const JoinPartyInputSchema = Schema.Struct({
  inviteCode: NonEmptyText,
})

const SuitSchema = Schema.Literals(SUITS)

export const PlayerCommandActionSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('pass') }),
  Schema.Struct({ type: Schema.Literal('exchange-kitty') }),
  Schema.Struct({ type: Schema.Literal('decline-exchange') }),
  Schema.Struct({ type: Schema.Literal('next-hand') }),
  Schema.Struct({ type: Schema.Literal('new-match') }),
  Schema.Struct({
    type: Schema.Literal('order-up'),
    alone: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal('call-trump'),
    suit: SuitSchema,
    alone: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal('discard'),
    cardId: NonEmptyText,
  }),
  Schema.Struct({
    type: Schema.Literal('play'),
    cardId: NonEmptyText,
  }),
])

export const SubmitCommandInputSchema = Schema.Struct({
  roomId: NonEmptyText,
  commandId: NonEmptyText,
  expectedVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  action: PlayerCommandActionSchema,
  responseVersion: Schema.optionalKey(Schema.Literal(2)),
})

export const VoteForBotInputSchema = Schema.Struct({
  roomId: NonEmptyText,
  disconnectedSeat: Schema.Literals([0, 1, 2, 3]),
  approve: Schema.Boolean,
})

function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, fallback: string) {
  const parse = Schema.decodeUnknownSync(schema)
  return (value: unknown): S['Type'] => {
    try {
      return parse(value)
    } catch {
      throw new Error(fallback)
    }
  }
}

export const rulesInput = (value: unknown) => {
  return decode(Schema.Struct({ rules: GameRulesSchema }), 'Invalid game rules.')(value).rules
}

export const createRoomInput = (value: unknown) => {
  const data = decode(CompatibleCreateRoomInputSchema, 'Invalid room creation request.')(value)
  if ('rules' in data) {
    return { ...data, legacy: data.operationId === undefined }
  }
  return { rules: data, legacy: true as const }
}

export const roomCreationInput = decode(RoomCreationInputSchema, 'Invalid room creation operation.')

export const roomIdInput = decode(RoomIdInputSchema, 'Invalid room ID.')

export const joinRoomInput = (value: unknown) => {
  const data = decode(JoinRoomInputSchema, 'Invalid invite code.')(value)
  return { code: data.code.toUpperCase() }
}

export const joinPartyInput = decode(JoinPartyInputSchema, 'Invalid partner invite.')

export const submitCommandInput = decode(SubmitCommandInputSchema, 'Invalid game command.')

export const voteForBotInput = decode(VoteForBotInputSchema, 'Invalid vote.')
