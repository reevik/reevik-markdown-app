/** A spinning arc in the current text colour. */
export default function Spinner({ size = 13, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={`shrink-0 animate-spin ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 3a9 9 0 019 9" />
    </svg>
  );
}
