import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppUpdateChannel } from "./appUpdates";

export const RELEASE_ANNOUNCEMENT_SEEN_STORAGE_KEY =
  "liveagent.release-announcement.seen-version.v1";

type VersionStorage = Pick<Storage, "getItem" | "setItem">;

export type AppReleaseAnnouncement = {
  currentVersion: string;
  date?: string | null;
  body: string;
  channel: AppUpdateChannel;
  releaseTag: string;
  releaseName?: string | null;
  releaseUrl?: string | null;
  repository: string;
};

export type ReleaseAnnouncementController = {
  announcement?: AppReleaseAnnouncement;
  open: boolean;
  preview: boolean;
  loading: boolean;
  message?: string;
  openAnnouncement: () => Promise<AppReleaseAnnouncement | undefined>;
  openPreviewAnnouncement: () => Promise<AppReleaseAnnouncement | undefined>;
  dismissForNow: () => void;
  acknowledge: () => void;
};

type UseReleaseAnnouncementControllerOptions = {
  enabled: boolean;
  currentVersion: string;
};

function browserStorage(): VersionStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readSeenReleaseAnnouncementVersion(storage = browserStorage()) {
  try {
    return storage?.getItem(RELEASE_ANNOUNCEMENT_SEEN_STORAGE_KEY)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function markReleaseAnnouncementSeen(version: string, storage = browserStorage()) {
  const normalized = version.trim();
  if (!normalized) return;
  try {
    storage?.setItem(RELEASE_ANNOUNCEMENT_SEEN_STORAGE_KEY, normalized);
  } catch {
    // A disabled localStorage should never block the announcement UI.
  }
}

export function shouldAutoShowReleaseAnnouncement(currentVersion: string, seenVersion?: string) {
  const normalized = currentVersion.trim();
  return Boolean(normalized && normalized !== seenVersion?.trim());
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error ?? "").trim() || "Failed to load the update announcement.";
}

export function useReleaseAnnouncementController({
  enabled,
  currentVersion,
}: UseReleaseAnnouncementControllerOptions): ReleaseAnnouncementController {
  const [announcement, setAnnouncement] = useState<AppReleaseAnnouncement>();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>();
  const announcementRef = useRef<AppReleaseAnnouncement | undefined>(undefined);
  const requestRef = useRef<Promise<AppReleaseAnnouncement | undefined> | null>(null);
  const attemptedVersionRef = useRef<string | undefined>(undefined);

  const loadAnnouncement = useCallback(() => {
    if (announcementRef.current) {
      return Promise.resolve(announcementRef.current);
    }
    if (requestRef.current) return requestRef.current;

    setLoading(true);
    setMessage(undefined);
    const request = invoke<AppReleaseAnnouncement | null>("app_release_announcement")
      .then((result) => {
        const next = result?.body?.trim() ? result : undefined;
        announcementRef.current = next;
        setAnnouncement(next);
        return next;
      })
      .catch((error) => {
        setMessage(errorMessage(error));
        throw error;
      })
      .finally(() => {
        if (requestRef.current === request) requestRef.current = null;
        setLoading(false);
      });
    requestRef.current = request;
    return request;
  }, []);

  const openAnnouncement = useCallback(async () => {
    const result = await loadAnnouncement();
    if (result) {
      setAnnouncement(result);
      setPreview(false);
      setOpen(true);
    }
    return result;
  }, [loadAnnouncement]);

  const openPreviewAnnouncement = useCallback(async () => {
    setLoading(true);
    setMessage(undefined);
    try {
      const result = await invoke<AppReleaseAnnouncement | null>(
        "app_release_announcement_preview",
      );
      const next = result?.body?.trim() ? result : undefined;
      if (next) {
        setAnnouncement(next);
        setPreview(true);
        setOpen(true);
      }
      return next;
    } catch (error) {
      setMessage(errorMessage(error));
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  const dismissForNow = useCallback(() => setOpen(false), []);

  const acknowledge = useCallback(() => {
    if (!preview) {
      const version = announcementRef.current?.currentVersion || currentVersion;
      markReleaseAnnouncementSeen(version);
    }
    setOpen(false);
  }, [currentVersion, preview]);

  useEffect(() => {
    const version = currentVersion.trim();
    if (!enabled || attemptedVersionRef.current === version) return;
    attemptedVersionRef.current = version;
    if (!shouldAutoShowReleaseAnnouncement(version, readSeenReleaseAnnouncementVersion())) return;

    void loadAnnouncement()
      .then((result) => {
        if (
          result?.currentVersion === version &&
          shouldAutoShowReleaseAnnouncement(version, readSeenReleaseAnnouncementVersion())
        ) {
          setOpen(true);
        }
      })
      .catch(() => undefined);
  }, [currentVersion, enabled, loadAnnouncement]);

  return useMemo(
    () => ({
      announcement,
      open,
      preview,
      loading,
      message,
      openAnnouncement,
      openPreviewAnnouncement,
      dismissForNow,
      acknowledge,
    }),
    [
      announcement,
      open,
      preview,
      loading,
      message,
      openAnnouncement,
      openPreviewAnnouncement,
      dismissForNow,
      acknowledge,
    ],
  );
}
