import Link from "next/link";

export function LandingCta({
  title,
  description,
  primary,
  secondary,
}: {
  title: string;
  description: string;
  primary: { href: string; label: string };
  secondary?: { href: string; label: string };
}) {
  return (
    <div className="mx-auto max-w-5xl px-6 pb-16">
      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--glass-bg-strong)] p-8 shadow-[var(--glass-shadow-strong)] backdrop-blur-[var(--glass-blur)]">
        <div className="grid gap-6 md:grid-cols-12 md:items-center">
          <div className="md:col-span-8">
            <div className="font-serif text-2xl font-black tracking-tight text-[var(--text-primary)]">
              {title}
            </div>
            <div className="mt-3 text-[15px] leading-relaxed text-[var(--text-secondary)]">
              {description}
            </div>
          </div>
          <div className="flex flex-wrap gap-3 md:col-span-4 md:justify-end">
            <Link
              href={primary.href}
              className="rounded-full bg-[var(--color-gold)] px-6 py-3 font-bold text-black hover:bg-[var(--color-gold-dark)]"
            >
              {primary.label}
            </Link>
            {secondary ? (
              <Link
                href={secondary.href}
                className="rounded-full border border-[var(--border-color)] px-6 py-3 font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              >
                {secondary.label}
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
