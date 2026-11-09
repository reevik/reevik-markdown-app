/**
 * A segmented control: a grey track with the selected option raised on a white
 * pill. The radii are explicit and concentric — track = pill + inset — so the
 * pill sits inside the track's curve. (Tailwind's `rounded-lg` reads the app's
 * own `--radius-lg`, 14px, which made the track far rounder than the pill.)
 */
const INSET = 3;
const PILL_RADIUS = 6;

export default function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  size = "sm",
  className = "",
}: {
  options: { id: T; label: string; title?: string }[];
  value: T;
  onChange: (id: T) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      className={`flex gap-0.5 bg-black/[0.06] ${className}`}
      style={{ padding: INSET, borderRadius: PILL_RADIUS + INSET }}
      role="tablist"
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            role="tab"
            aria-selected={active}
            onClick={() => !active && onChange(o.id)}
            disabled={disabled}
            title={o.title}
            style={{ borderRadius: PILL_RADIUS }}
            className={`flex-1 px-2 py-1 transition-colors ${size === "md" ? "text-[12px]" : "text-[11.5px]"} ${
              active
                ? "bg-white/85 font-medium text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.12)]"
                : "text-[var(--text-secondary)] hover:bg-white/40"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
