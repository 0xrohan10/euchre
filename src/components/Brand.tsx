export function Brand() {
  return (
    <a className="brand" href="/" aria-label="Homepage">
      <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
        <rect
          className="brand-mark-back"
          x="4"
          y="4.5"
          width="11"
          height="15"
          rx="2.6"
          transform="rotate(-20 9.5 12)"
        />
        <rect className="brand-mark-front" x="11.2" y="3.5" width="11" height="16" rx="2.8" />
        <path className="brand-mark-pip" d="M16.7 8.7 19.5 11.5 16.7 14.3 13.9 11.5Z" />
      </svg>
      <span>Euchs</span>
    </a>
  )
}
