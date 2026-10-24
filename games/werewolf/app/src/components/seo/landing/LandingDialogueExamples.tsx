import Image from "next/image";
import { buildSimpleAvatarUrl } from "@/lib/avatar-config";

export interface LandingDialogueSpeaker {
  seed: string;
  name: string;
  modelLogo: string;
  meta?: string;
}

export interface LandingDialogueLine {
  speaker: LandingDialogueSpeaker;
  content: string;
}

export interface LandingDialogueExample {
  title: string;
  subtitle?: string;
  lines: LandingDialogueLine[];
}

export function LandingDialogueExamples({ examples }: { examples: LandingDialogueExample[] }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {examples.map((ex) => (
        <div
          key={ex.title}
          className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-6"
        >
          <div className="text-lg font-bold text-[var(--text-primary)]">{ex.title}</div>
          {ex.subtitle ? (
            <div className="mt-1 text-sm text-[var(--text-secondary)]">{ex.subtitle}</div>
          ) : null}

          <div className="mt-5 grid gap-4">
            {ex.lines.map((line, idx) => (
              <div key={`${ex.title}-${idx}`} className="flex items-start gap-3">
                <div className="mt-0.5 h-9 w-9 shrink-0 overflow-hidden rounded-full border border-[var(--border-color)]">
                  <img
                    src={buildSimpleAvatarUrl(line.speaker.seed)}
                    alt={line.speaker.name}
                    className="h-full w-full"
                  />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <span className="truncate font-semibold text-[var(--text-secondary)]">
                      {line.speaker.name}
                    </span>
                    <Image src={line.speaker.modelLogo} alt="" width={14} height={14} className="opacity-90" />
                    {line.speaker.meta ? <span className="truncate">{line.speaker.meta}</span> : null}
                  </div>

                  <div className="mt-1 rounded-xl border border-[var(--chat-bubble-border)] bg-[var(--chat-bubble-bg)] px-4 py-3 text-sm leading-relaxed text-[var(--chat-bubble-text)] shadow-sm">
                    {line.content}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
