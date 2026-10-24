"use client";

import { useCallback, useState } from "react";
import { Eye, EyeSlash, Key } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  clearApiKeys,
  getMinimaxApiKey,
  getMinimaxGroupId,
  getOpenAIBaseUrl,
  getOpenAIApiKey,
  getOpenAIModel,
  getOpenAIMaxTokens,
  getOpenAIJsonObjectEnabled,
  getOpenAIReasoningEffort,
  getOpenAIReasoningStyle,
  getOpenAIThinkingEnabled,
  isOpenAICompatConfigured,
  type ReasoningStyle,
  setMinimaxApiKey,
  setMinimaxGroupId,
  setModelSource,
  setOpenAIBaseUrl,
  setOpenAIApiKey,
  setOpenAIMaxTokens,
  setOpenAIModel,
  setOpenAIJsonObjectEnabled,
  setOpenAIReasoningEffort,
  setOpenAIReasoningStyle,
  setOpenAIThinkingEnabled,
} from "@/lib/api-keys";

const EFFORT_OPTIONS = ["minimal", "low", "medium", "high", "max"] as const;
const EFFORT_LABEL_KEYS: Record<string, string> = {
  minimal: "customKey.openai.effortMinimal",
  low: "customKey.openai.effortLow",
  medium: "customKey.openai.effortMedium",
  high: "customKey.openai.effortHigh",
  max: "customKey.openai.effortMax",
};

export function ConnectionSettingsForm({
  onSaved,
}: {
  onSaved?: () => void;
}) {
  const t = useTranslations();
  const [baseUrl, setBaseUrl] = useState(() => getOpenAIBaseUrl());
  const [apiKey, setApiKey] = useState(() => getOpenAIApiKey());
  const [model, setModel] = useState(() => getOpenAIModel());
  const [thinking, setThinking] = useState(() => getOpenAIThinkingEnabled());
  const [effort, setEffort] = useState<string>(() => {
    const storedEffort = getOpenAIReasoningEffort();
    return EFFORT_OPTIONS.includes(storedEffort as never) ? storedEffort : "medium";
  });
  const [reasoningStyle, setReasoningStyle] = useState<ReasoningStyle>(() => getOpenAIReasoningStyle());
  const [jsonObject, setJsonObject] = useState(() => getOpenAIJsonObjectEnabled());
  const [maxTokens, setMaxTokens] = useState<string>(() => {
    const value = getOpenAIMaxTokens();
    return value === null ? "" : String(value);
  });
  const [minimaxKey, setMinimaxKeyState] = useState(() => getMinimaxApiKey());
  const [minimaxGroupId, setMinimaxGroupIdState] = useState(() => getMinimaxGroupId());
  const [showKey, setShowKey] = useState(false);
  const [showMinimaxKey, setShowMinimaxKey] = useState(false);
  const [showMinimaxGroup, setShowMinimaxGroup] = useState(false);

  const configured = isOpenAICompatConfigured();
  const minimaxConfigured = Boolean(getMinimaxApiKey() && getMinimaxGroupId());

  const handleSave = useCallback(() => {
    if (!baseUrl.trim() || !apiKey.trim() || !model.trim()) {
      toast.error(t("customKey.toasts.needLlmKey"), {
        description: t("customKey.openai.howToEnable"),
      });
      return;
    }
    setOpenAIBaseUrl(baseUrl.trim().replace(/\/+$/, ""));
    setOpenAIApiKey(apiKey.trim());
    setOpenAIModel(model.trim());
    setOpenAIThinkingEnabled(thinking);
    setOpenAIReasoningEffort(effort);
    setOpenAIReasoningStyle(reasoningStyle);
    setOpenAIJsonObjectEnabled(jsonObject);
    setOpenAIMaxTokens(maxTokens.trim());
    setMinimaxApiKey(minimaxKey.trim());
    setMinimaxGroupId(minimaxGroupId.trim());
    setModelSource("custom");
    toast.success(t("customKey.toasts.saved"), {
      description: t("customKey.toasts.savedDesc"),
    });
    onSaved?.();
  }, [apiKey, baseUrl, effort, jsonObject, maxTokens, minimaxGroupId, minimaxKey, model, onSaved, reasoningStyle, t, thinking]);

  const handleClear = useCallback(() => {
    clearApiKeys();
    setBaseUrl("");
    setApiKey("");
    setModel("");
    setThinking(false);
    setEffort("medium");
    setReasoningStyle("auto");
    setJsonObject(true);
    setMaxTokens("");
    setMinimaxKeyState("");
    setMinimaxGroupIdState("");
    toast.success(t("customKey.toasts.cleared"));
  }, [t]);

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-[var(--text-primary)]">
              {t("customKey.openai.title")}
            </h3>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              {t("customKey.openai.description")}
            </p>
          </div>
          {configured && (
            <span className="shrink-0 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-600">
              {t("customKey.openai.enabled")}
            </span>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="llm-base-url" className="text-xs">
            {t("customKey.openai.baseUrl")}
          </Label>
          <Input
            id="llm-base-url"
            name="wolfcha-openai-base-url"
            type="text"
            autoComplete="off"
            placeholder={t("customKey.openai.baseUrlPlaceholder")}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="llm-api-key" className="text-xs">
            {t("customKey.openai.apiKey")}
          </Label>
          <div className="flex gap-2">
            <Input
              id="llm-api-key"
              name="wolfcha-openai-api-key"
              type={showKey ? "text" : "password"}
              autoComplete="new-password"
              placeholder={t("customKey.openai.apiKeyPlaceholder")}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? t("customKey.openai.hideKey") : t("customKey.openai.showKey")}
            >
              {showKey ? <EyeSlash size={16} /> : <Eye size={16} />}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="llm-model" className="text-xs">
            {t("customKey.openai.model")}
          </Label>
          <Input
            id="llm-model"
            name="wolfcha-openai-model"
            type="text"
            autoComplete="off"
            placeholder={t("customKey.openai.modelPlaceholder")}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
          <div className="min-w-0">
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {t("customKey.openai.thinking")}
            </span>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {t("customKey.openai.thinkingDesc")}
            </p>
          </div>
          <Switch checked={thinking} onCheckedChange={setThinking} aria-label={t("customKey.openai.thinking")} />
        </div>

        {thinking && (
          <div className="space-y-1.5">
            <Label htmlFor="llm-effort" className="text-xs">
              {t("customKey.openai.effort")}
            </Label>
            <Select value={effort} onValueChange={setEffort}>
              <SelectTrigger id="llm-effort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EFFORT_OPTIONS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(EFFORT_LABEL_KEYS[value] as never)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-[var(--text-muted)]">{t("customKey.openai.effortHint")}</p>

            <div className="space-y-1.5 pt-2">
              <Label htmlFor="llm-reasoning-style" className="text-xs">
                {t("customKey.openai.style")}
              </Label>
              <Select value={reasoningStyle} onValueChange={(value) => setReasoningStyle(value as ReasoningStyle)}>
                <SelectTrigger id="llm-reasoning-style">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("customKey.openai.styleAuto")}</SelectItem>
                  <SelectItem value="thinking">{t("customKey.openai.styleThinking")}</SelectItem>
                  <SelectItem value="reasoning_effort">{t("customKey.openai.styleReasoning")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-[var(--text-muted)]">{t("customKey.openai.styleDesc")}</p>
            </div>

          </div>
        )}

        <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
          <div className="min-w-0">
            <span className="text-sm font-medium text-[var(--text-primary)]">
              {t("customKey.openai.jsonObject")}
            </span>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {t("customKey.openai.jsonObjectDesc")}
            </p>
          </div>
          <Switch checked={jsonObject} onCheckedChange={setJsonObject} aria-label={t("customKey.openai.jsonObject")} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="llm-max-tokens" className="text-xs">
            {t("customKey.openai.maxTokens")}
          </Label>
          <Input
            id="llm-max-tokens"
            name="wolfcha-openai-max-tokens"
            type="number"
            min={1}
            step={256}
            autoComplete="off"
            placeholder={t("customKey.openai.maxTokensPlaceholder")}
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
          />
          <p className="text-xs text-[var(--text-muted)]">{t("customKey.openai.maxTokensDesc")}</p>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-[var(--text-primary)]">
            {t("customKey.voice.title")}
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            {t("customKey.voice.description")}
          </p>
        </div>
        {minimaxConfigured && (
          <span className="inline-block rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-600">
            {t("customKey.openai.enabled")}
          </span>
        )}
        <div className="space-y-2">
          <Label htmlFor="minimax-key" className="text-xs">
            {t("customKey.minimax.keyLabel")}
          </Label>
          <div className="flex gap-2">
            <Input
              id="minimax-key"
              type={showMinimaxKey ? "text" : "password"}
              autoComplete="new-password"
              placeholder={t("customKey.optionalPlaceholder")}
              value={minimaxKey}
              onChange={(e) => setMinimaxKeyState(e.target.value)}
              className="flex-1"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => setShowMinimaxKey((v) => !v)}>
              {showMinimaxKey ? <EyeSlash size={16} /> : <Eye size={16} />}
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="minimax-group" className="text-xs">
            {t("customKey.minimax.groupLabel")}
          </Label>
          <div className="flex gap-2">
            <Input
              id="minimax-group"
              type={showMinimaxGroup ? "text" : "password"}
              autoComplete="new-password"
              placeholder={t("customKey.optionalPlaceholder")}
              value={minimaxGroupId}
              onChange={(e) => setMinimaxGroupIdState(e.target.value)}
              className="flex-1"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => setShowMinimaxGroup((v) => !v)}>
              {showMinimaxGroup ? <EyeSlash size={16} /> : <Eye size={16} />}
            </Button>
          </div>
        </div>
      </section>

      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={handleClear} className="flex-1">
          {t("customKey.actions.clear")}
        </Button>
        <Button type="button" onClick={handleSave} className="flex-1">
          {t("customKey.actions.save")}
        </Button>
      </div>
    </div>
  );
}

export function ModelConnectionModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-md max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-serif text-[var(--text-primary)]">
            <Key size={18} />
            {t("customKey.title")}
          </DialogTitle>
          <DialogDescription className="text-[var(--text-muted)]">
            {t("customKey.description")}
          </DialogDescription>
        </DialogHeader>
        <ConnectionSettingsForm onSaved={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
