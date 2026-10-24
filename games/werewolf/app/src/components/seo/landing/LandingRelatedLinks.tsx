import Link from "next/link";

export interface LandingRelatedLink {
  href: string;
  label: string;
  description?: string;
}

export function LandingRelatedLinks({
  title,
  links,
}: {
  title: string;
  links: LandingRelatedLink[];
}) {
  return (
    <div>
      <div className="text-sm font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
        {title}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-5 transition-colors hover:bg-[var(--bg-hover)]"
          >
            <div className="text-[15px] font-bold text-[var(--text-primary)]">{l.label}</div>
            {l.description ? (
              <div className="mt-1 text-sm text-[var(--text-secondary)]">{l.description}</div>
            ) : null}
          </Link>
        ))}
      </div>
    </div>
  );
}
