interface ScalePadLogoProps {
  compact?: boolean;
}

/** Navy-safe ScalePad lockup. The mark stays white so it remains crisp on dark surfaces. */
export function ScalePadLogo({ compact = false }: ScalePadLogoProps) {
  return (
    <img
      src="/sp_marketplace.png"
      alt="ScalePad App Marketplace"
      className={compact ? "h-auto w-[208px] object-contain" : "h-auto w-[260px] object-contain"}
    />
  );
}
