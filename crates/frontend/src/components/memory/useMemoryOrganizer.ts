// Thin React binding for the organizer service: instantiates it once, feeds
// settings changes to configure(), and uninstalls on unmount. All engine
// logic lives in lib/memory/organizer/service.ts.

import { useEffect, useRef } from "react";
import {
  createMemoryOrganizerService,
  installMemoryOrganizerService,
  type MemoryOrganizerService,
} from "../../lib/memory/organizer/service";
import type { AppSettings } from "../../lib/settings";

type SetSettings = (updater: (prev: AppSettings) => AppSettings) => void;

export function useMemoryOrganizer(settings: AppSettings, setSettings: SetSettings) {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const setSettingsRef = useRef(setSettings);
  setSettingsRef.current = setSettings;

  const serviceRef = useRef<MemoryOrganizerService | null>(null);

  useEffect(() => {
    const service = createMemoryOrganizerService({
      getSettings: () => settingsRef.current,
      setSettings: (updater) => setSettingsRef.current(updater),
    });
    serviceRef.current = service;
    installMemoryOrganizerService(service);
    service.configure();
    return () => {
      serviceRef.current = null;
      installMemoryOrganizerService(null);
      service.dispose();
    };
  }, []);

  // Re-arm the wake timer when scheduling-relevant settings change. The
  // service reads fresh settings through the ref, so this is a cheap tick.
  const { organizerEnabled, organizerSchedule, organizerNextRunAt, organizerModel } =
    settings.memory;
  const scheduleKey = `${organizerEnabled}:${organizerSchedule.frequency}:${organizerNextRunAt ?? 0}:${
    organizerModel ? `${organizerModel.customProviderId}/${organizerModel.model}` : ""
  }`;
  useEffect(() => {
    serviceRef.current?.configure();
  }, [scheduleKey]);
}

export function MemoryOrganizerHost(props: { settings: AppSettings; setSettings: SetSettings }) {
  useMemoryOrganizer(props.settings, props.setSettings);
  return null;
}
