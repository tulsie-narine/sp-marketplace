interface ScalePadMarkProps {
  className?: string;
}

/** The six-square ScalePad mark for compact app identity surfaces. */
export function ScalePadMark({ className = "h-9 w-9" }: ScalePadMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={`grid grid-cols-3 grid-rows-3 gap-1 ${className}`}
    >
      <span className="col-start-3 row-start-1 rounded-[3px] bg-current" />
      <span className="col-start-2 row-start-2 rounded-[3px] bg-current" />
      <span className="col-start-3 row-start-2 rounded-[3px] bg-current" />
      <span className="col-start-1 row-start-3 rounded-[3px] bg-current" />
      <span className="col-start-2 row-start-3 rounded-[3px] bg-current" />
      <span className="col-start-3 row-start-3 rounded-[3px] bg-current" />
    </span>
  );
}
