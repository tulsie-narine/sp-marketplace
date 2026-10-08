import { CATEGORIES } from "@/lib/constants";

interface CategoryChipsProps {
  selected: string;
  onChange: (cat: string) => void;
}

export function CategoryChips({ selected, onChange }: CategoryChipsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
      {CATEGORIES.map((cat) => (
        <button
          key={cat}
          onClick={() => onChange(cat)}
          className={`shrink-0 px-4 py-2 rounded-lg text-[15px] font-semibold transition-colors duration-150 ${
            selected === cat
              ? "bg-primary text-primary-foreground"
              : "bg-surface-raised text-muted-foreground hover:text-foreground border border-border"
          }`}
        >
          {cat}
        </button>
      ))}
    </div>
  );
}
