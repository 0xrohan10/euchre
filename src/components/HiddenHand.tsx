import { cardBackImage } from '../card-assets'

export function HiddenHand({ count }: { count: number }) {
  return (
    <div className="hidden-hand" aria-label={`${count} hidden cards`}>
      {Array.from({ length: count }, (_, index) => {
        return <img className="card-back" src={cardBackImage} alt="" key={index} />
      })}
    </div>
  )
}
