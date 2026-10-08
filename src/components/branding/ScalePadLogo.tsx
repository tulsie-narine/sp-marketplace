interface ScalePadLogoProps {
  compact?: boolean;
}

/** Navy-safe ScalePad lockup. The mark stays white so it remains crisp on dark surfaces. */
export function ScalePadLogo({ compact = false }: ScalePadLogoProps) {
  return (
    <div className={`inline-flex items-center ${compact ? "gap-2.5" : "gap-3"}`} aria-label="ScalePad">
      <span className={`grid grid-cols-3 grid-rows-3 ${compact ? "h-7 w-7 gap-0.5" : "h-10 w-10 gap-1"}`} aria-hidden="true">
        {[
          "col-start-1 row-start-3",
          "col-start-2 row-start-3",
          "col-start-3 row-start-3",
          "col-start-2 row-start-2",
          "col-start-3 row-start-2",
          "col-start-3 row-start-1",
        ].map((position) => (
          <span
            key={position}
            className={`${position} rounded-[2px] bg-white/95 ${compact ? "h-2 w-2" : "h-3 w-3"}`}
          />
        ))}
      </span>
      <span className={`font-heading font-bold tracking-[-0.04em] text-white ${compact ? "text-xl" : "text-3xl"}`}>
        ScalePad
      </span>
    </div>
  );
}
