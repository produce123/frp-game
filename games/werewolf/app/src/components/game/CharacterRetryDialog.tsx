"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";

export interface CharacterRetryRequest {
  message: string;
  batchStartIndex: number;
  attempt: number;
}

interface CharacterRetryDialogProps {
  retry: CharacterRetryRequest | null;
  onConfirm: (ok: boolean) => void;
}

export function CharacterRetryDialog({ retry, onConfirm }: CharacterRetryDialogProps) {
  const t = useTranslations();
  return (
    <Dialog
      open={!!retry}
      onOpenChange={(open) => {
        if (!open) onConfirm(false);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowsClockwise size={18} />
            {t("gameLogicMessages.characterRetry.title")}
          </DialogTitle>
          <DialogDescription>
            {t("gameLogicMessages.characterRetry.description", {
              batch: retry?.batchStartIndex ?? 0,
              attempt: retry?.attempt ?? 1,
            })}
          </DialogDescription>
        </DialogHeader>
        {retry?.message ? (
          <p className="max-h-20 overflow-y-auto break-all text-xs text-[var(--text-muted)]">
            {retry.message}
          </p>
        ) : null}
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onConfirm(false)}
            className="flex-1"
          >
            {t("gameLogicMessages.characterRetry.cancel")}
          </Button>
          <Button type="button" onClick={() => onConfirm(true)} className="flex-1 gap-2">
            <ArrowsClockwise size={16} />
            {t("gameLogicMessages.characterRetry.retry")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
