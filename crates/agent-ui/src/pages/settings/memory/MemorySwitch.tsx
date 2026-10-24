// K-brain memory master switch shown above the memory panel. Hidden unless the
// connected backend advertises the switch, so older backends see no change.
//
// Shared implementation owned by @liveagent/ui.

import { SettingsRow } from "@liveagent/ui/components/settings/SettingsLayout";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useRef, useState } from "react";
import type { KBrainSettingsAdapter } from "../kbrainSettingsAdapter";

/** Authoritative switch state, or null when the backend does not support it or is unreachable. */
export async function loadMemorySwitch(kbrain: KBrainSettingsAdapter): Promise<boolean | null> {
  try {
    if (kbrain.getCapabilities) {
      const capabilities = await kbrain.getCapabilities();
      if (capabilities.memory_switch !== 1) return null;
    }
    const enabled = (await kbrain.getSettings()).memory?.enabled;
    return typeof enabled === "boolean" ? enabled : null;
  } catch {
    return null;
  }
}

export function MemorySwitch({ kbrain }: { kbrain: KBrainSettingsAdapter }) {
  const { t } = useLocale();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const epoch = useRef(0);
  const savingRef = useRef(false);

  useEffect(() => {
    const load = () => {
      const ticket = ++epoch.current;
      void loadMemorySwitch(kbrain).then((value) => {
        if (ticket === epoch.current) setEnabled(value);
      });
    };
    // Another mounted switch (the memory hub under the settings overlay) may save;
    // the saving instance already holds the backend's answer.
    const onChanged = () => {
      if (!savingRef.current) load();
    };
    load();
    window.addEventListener("kbrain:settings-changed", onChanged);
    return () => {
      ++epoch.current;
      window.removeEventListener("kbrain:settings-changed", onChanged);
    };
  }, [kbrain]);

  async function change(next: boolean) {
    if (saving || enabled === null || next === enabled) return;
    const ticket = ++epoch.current;
    savingRef.current = true;
    setSaving(true);
    setEnabled(next);
    try {
      const saved = (await kbrain.updateSettings({ memory: { enabled: next } })).memory?.enabled;
      if (ticket !== epoch.current) return;
      setEnabled(typeof saved === "boolean" ? saved : next);
      window.dispatchEvent(new Event("kbrain:settings-changed"));
    } catch {
      if (ticket !== epoch.current) return;
      toast.error(t("settings.memorySwitchSaveFailed"));
      // Roll back to what the backend holds, not to the guess before the click.
      const current = await loadMemorySwitch(kbrain);
      if (ticket === epoch.current) setEnabled(current);
    } finally {
      savingRef.current = false;
      if (ticket === epoch.current) setSaving(false);
    }
  }

  if (enabled === null) return null;
  return (
    <SettingsRow
      data-testid="memory-master-switch"
      aria-busy={saving}
      title={t("settings.memorySwitchTitle")}
      description={t(
        enabled ? "settings.memorySwitchOnDescription" : "settings.memorySwitchOffDescription",
      )}
      control={
        <Switch
          checked={enabled}
          disabled={saving}
          onCheckedChange={(checked) => void change(checked === true)}
          aria-label={t("settings.memorySwitchTitle")}
        />
      }
    />
  );
}
