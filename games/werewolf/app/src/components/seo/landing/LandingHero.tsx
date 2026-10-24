import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

export function LandingHero({
  title,
  subtitle,
  description,
  primaryCta,
  secondaryCta,
  image,
  aside,
}: {
  title: string;
  subtitle?: string;
  description: string;
  primaryCta: { href: string; label: string };
  secondaryCta?: { href: string; label: string };
  image?: { src: string; alt: string };
  aside?: ReactNode;
}) {
  return (
    <section className="mx-auto max-w-7xl px-6 py-16">
      <div className="grid gap-10 lg:grid-cols-12 lg:items-center">
        <div className="lg:col-span-7">
          {subtitle ? (
            <div className="inline-flex items-center rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-1.5 text-xs font-semibold tracking-wide text-[var(--text-secondary)]">
              {subtitle}
            </div>
          ) : null}

          <h1 className="mt-5 font-serif text-4xl font-black tracking-tight text-[var(--text-primary)] md:text-5xl">
            {title}
          </h1>

          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-[var(--text-secondary)]">
            {description}
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href={primaryCta.href}
              className="rounded-full bg-[var(--color-gold)] px-6 py-3 font-bold text-black hover:bg-[var(--color-gold-dark)]"
            >
              {primaryCta.label}
            </Link>
            {secondaryCta ? (
              <Link
                href={secondaryCta.href}
                className="rounded-full border border-[var(--border-color)] px-6 py-3 font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              >
                {secondaryCta.label}
              </Link>
            ) : null}
          </div>
        </div>

        <div className="lg:col-span-5">
          <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--glass-bg)] p-5 shadow-[var(--glass-shadow)] backdrop-blur-[var(--glass-blur)]">
            {image ? (
              <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)]">
                <Image src={image.src} alt={image.alt} fill className="object-contain" priority />
              </div>
            ) : null}

            {aside ? <div className={image ? "mt-5" : ""}>{aside}</div> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
