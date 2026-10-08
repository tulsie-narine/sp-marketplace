interface ScalePadLogoProps {
  compact?: boolean;
}

/** Navy-safe ScalePad lockup. The mark stays white so it remains crisp on dark surfaces. */
export function ScalePadLogo({ compact = false }: ScalePadLogoProps) {
  return (
    <div className={`inline-flex items-center ${compact ? "gap-2.5" : "gap-3"}`} aria-label="ScalePad">
      <span className={`grid grid-cols-3 items-end ${compact ? "h-7 w-7 gap-0.5" : "h-10 w-10 gap-1"}`} aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((tile) => (
          <span
            key={tile}
            className={`rounded-[2px] bg-white/95 ${compact ? "h-2 w-2" : "h-3 w-3"}`}
            style={{ transform: `translateY(${(2 - Math.floor(tile / 3)) * (compact ? 2 : 3)}px)` }}
          />
        ))}
      </span>
      <span className={`font-heading font-bold tracking-[-0.04em] text-white ${compact ? "text-xl" : "text-3xl"}`}>
        ScalePad
      </span>
    </div>
  );
}
