import type { AgentPromptTemplate } from "@liveagent/app/lib/settings";
import { FormField } from "@liveagent/ui/components/settings/FormField";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";

type AgentPromptTemplateModalProps = {
  initialData?: AgentPromptTemplate;
  onSave: (data: Omit<AgentPromptTemplate, "id" | "enabled">) => void;
  onClose: () => void;
};

export function AgentPromptTemplateModal({
  initialData,
  onSave,
  onClose,
}: AgentPromptTemplateModalProps) {
  const { t } = useLocale();
  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [prompt, setPrompt] = useState(initialData?.prompt ?? "");
  const isEditing = Boolean(initialData);

  function handleSave() {
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName || !trimmedPrompt) return;

    onSave({
      name: trimmedName,
      description: description.trim(),
      prompt: trimmedPrompt,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex h-[min(44rem,calc(100dvh-2rem))] max-w-xl flex-col"
        closeLabel={t("settings.cancel")}
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>
            {isEditing ? t("settings.agentsEdit") : t("settings.agentsAdd")}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <FormField>
            <Label htmlFor="agent-template-name">{t("settings.agentsName")}</Label>
            <Input
              variant="plain"
              id="agent-template-name"
              value={name}
              placeholder={t("settings.agentsNamePlaceholder")}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </FormField>
          <FormField>
            <Label htmlFor="agent-template-description">{t("settings.agentsDescription")}</Label>
            <Textarea
              variant="plain"
              id="agent-template-description"
              value={description}
              placeholder={t("settings.agentsDescriptionPlaceholder")}
              onChange={(e) => setDescription(e.currentTarget.value)}
              className="min-h-20 resize-y"
            />
          </FormField>
          <FormField>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="agent-template-prompt">{t("settings.agentsPrompt")}</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {prompt.length.toLocaleString()} {t("settings.agentsCharacters")}
              </span>
            </div>
            <Textarea
              variant="plain"
              id="agent-template-prompt"
              value={prompt}
              placeholder={t("settings.agentsPromptPlaceholder")}
              onChange={(e) => setPrompt(e.currentTarget.value)}
              className="min-h-64 resize-y font-mono text-sm leading-6"
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("settings.agentsPromptHint")}
            </p>
          </FormField>
        </DialogBody>
        <DialogFooter>
          <DialogActions>
            <Button size="sm" variant="outline" onClick={onClose}>
              {t("settings.cancel")}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!name.trim() || !prompt.trim()}>
              {t("settings.save")}
            </Button>
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
