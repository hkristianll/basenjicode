import logoUrl from '../assets/logo.png'

/** The app logo. Rendered as an <img> so the SVG's own gradient/filter ids stay isolated
 * (no collisions across instances) and its glow effects render. Matches resources/icon. */
export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
