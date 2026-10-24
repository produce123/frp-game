import Image from "next/image";
import { cn } from "@/lib/utils";
import { buildSimpleAvatarUrl } from "@/lib/avatar-config";

export interface LandingAiSeat {
  seed: string;
  name: string;
  persona: string;
  modelLogo: string;
}

export function LandingAiSeats({
  seats,
  compact = false,
}: {
  seats: LandingAiSeat[];
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid gap-3",
        compact ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
      )}
    >
      {seats.map((s) => (
        <div
          key={`${s.seed}-${s.modelLogo}`}
          className={cn(
            "flex items-center gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)]",
            compact ? "p-3" : "p-4"
          )}
        >
          <img
            src={buildSimpleAvatarUrl(s.seed)}
            alt={s.name}
            className={cn("rounded-full border", compact ? "h-10 w-10" : "h-12 w-12", "border-[var(--border-color)]")}
          />
          <div className="min-w-0 flex-1">
            <div className={cn("flex items-center gap-2", compact ? "text-sm" : "text-[15px]")}
            >
              <span className="truncate font-semibold text-[var(--text-primary)]">{s.name}</span>
              <Image src={s.modelLogo} alt="" width={16} height={16} className="opacity-90" />
            </div>
            <div className={cn("truncate text-[var(--text-secondary)]", compact ? "text-xs" : "text-sm")}>{s.persona}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
