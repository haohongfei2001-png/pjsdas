import { brandAssetUrl } from './brand.js'

/** Decorative alongside the visible wordmark; the parent owns the accessible name. */
export default function BrandMark({ className = '', size = 30 }: { className?: string; size?: number }) {
  return <img className={className} src={brandAssetUrl('a-mark-primary.svg')} width={size} height={size} alt="" aria-hidden="true" />
}
