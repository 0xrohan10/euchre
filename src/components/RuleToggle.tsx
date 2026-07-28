export function RuleToggle({
  checked,
  description,
  disabled,
  onChange,
  title,
}: {
  checked: boolean
  description: string
  disabled: boolean
  onChange: (checked: boolean) => void
  title: string
}) {
  return (
    <label className="rule-toggle">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          return onChange(event.target.checked)
        }}
      />
      <i aria-hidden="true" />
    </label>
  )
}
