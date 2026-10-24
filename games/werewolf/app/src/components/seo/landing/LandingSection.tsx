import type { ReactNode } from "react";

export function LandingSection({
  id,
  title,
  subtitle,
  children,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mx-auto max-w-5xl px-6 py-14">
      <header>
        <h2 className="font-serif text-2xl font-black tracking-tight text-[var(--text-primary)] md:text-3xl">
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-[var(--text-secondary)] md:text-base">
            {subtitle}
          </p>
        ) : null}
      </header>
      <div className="mt-8">{children}</div>
    </section>
  );
}
