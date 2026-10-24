export interface LandingFaqItem {
  question: string;
  answer: string;
}

export function LandingFaq({ items }: { items: LandingFaqItem[] }) {
  return (
    <div className="grid gap-3">
      {items.map((item) => (
        <details
          key={item.question}
          className="group rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-5"
        >
          <summary className="cursor-pointer list-none text-[15px] font-semibold text-[var(--text-primary)]">
            {item.question}
          </summary>
          <div className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">{item.answer}</div>
        </details>
      ))}
    </div>
  );
}
