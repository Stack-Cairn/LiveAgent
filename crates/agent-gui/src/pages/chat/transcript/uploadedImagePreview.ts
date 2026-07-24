import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type UploadedImagePreviewResponse = {
  mimeType: string;
  data: string;
};

const uploadedImagePreviewCache = new Map<string, string>();
const uploadedImagePreviewRequests = new Map<string, Promise<string | null>>();
const UPLOADED_IMAGE_PREVIEW_CACHE_LIMIT = 64;

function getUploadedImagePreviewCacheKey(
  workspaceRoot: string,
  absolutePath: string,
  cacheVariant = "",
) {
  return cacheVariant
    ? `${workspaceRoot}\n${absolutePath}\n${cacheVariant}`
    : `${workspaceRoot}\n${absolutePath}`;
}

function readUploadedImagePreviewCache(cacheKey: string) {
  const cached = uploadedImagePreviewCache.get(cacheKey);
  if (cached === undefined) return undefined;
  uploadedImagePreviewCache.delete(cacheKey);
  uploadedImagePreviewCache.set(cacheKey, cached);
  return cached;
}

function writeUploadedImagePreviewCache(cacheKey: string, value: string) {
  uploadedImagePreviewCache.delete(cacheKey);
  uploadedImagePreviewCache.set(cacheKey, value);

  while (uploadedImagePreviewCache.size > UPLOADED_IMAGE_PREVIEW_CACHE_LIMIT) {
    const oldestKey = uploadedImagePreviewCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    uploadedImagePreviewCache.delete(oldestKey);
  }
}

async function loadUploadedImagePreview(params: {
  workspaceRoot: string;
  absolutePath: string;
  cacheVariant?: string;
}) {
  const { workspaceRoot, absolutePath, cacheVariant } = params;
  const cacheKey = getUploadedImagePreviewCacheKey(workspaceRoot, absolutePath, cacheVariant);
  const cached = readUploadedImagePreviewCache(cacheKey);
  if (cached !== undefined) return cached;

  const existing = uploadedImagePreviewRequests.get(cacheKey);
  if (existing) return existing;

  const request = invoke<UploadedImagePreviewResponse>("system_read_uploaded_image_preview", {
    workdir: workspaceRoot,
    absolute_path: absolutePath,
  })
    .then((result) => {
      const mimeType =
        typeof result.mimeType === "string" && result.mimeType.trim()
          ? result.mimeType
          : "application/octet-stream";
      const data = typeof result.data === "string" ? result.data.trim() : "";
      const next = data ? `data:${mimeType};base64,${data}` : null;
      if (next) {
        writeUploadedImagePreviewCache(cacheKey, next);
      }
      return next;
    })
    .catch(() => null)
    .finally(() => {
      uploadedImagePreviewRequests.delete(cacheKey);
    });

  uploadedImagePreviewRequests.set(cacheKey, request);
  return request;
}

export function useUploadedImagePreview(
  absolutePath?: string,
  workspaceRoot?: string,
  cacheVariant?: string,
) {
  const normalizedPath = typeof absolutePath === "string" ? absolutePath.trim() : "";
  const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  const normalizedCacheVariant = typeof cacheVariant === "string" ? cacheVariant.trim() : "";
  const cacheKey =
    normalizedPath && normalizedWorkspaceRoot
      ? getUploadedImagePreviewCacheKey(
          normalizedWorkspaceRoot,
          normalizedPath,
          normalizedCacheVariant,
        )
      : "";
  const [imageSrc, setImageSrc] = useState<string | null | undefined>(() => {
    if (!cacheKey) return null;
    return readUploadedImagePreviewCache(cacheKey);
  });

  useEffect(() => {
    if (!cacheKey || !normalizedPath || !normalizedWorkspaceRoot) {
      setImageSrc(null);
      return;
    }

    const cached = readUploadedImagePreviewCache(cacheKey);
    if (cached !== undefined) {
      setImageSrc(cached);
      return;
    }

    let cancelled = false;
    setImageSrc(undefined);
    void loadUploadedImagePreview({
      workspaceRoot: normalizedWorkspaceRoot,
      absolutePath: normalizedPath,
      cacheVariant: normalizedCacheVariant,
    }).then((value) => {
      if (!cancelled) {
        setImageSrc(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, normalizedCacheVariant, normalizedPath, normalizedWorkspaceRoot]);

  return {
    imageSrc: imageSrc ?? null,
    isLoading: Boolean(cacheKey) && imageSrc === undefined,
  };
}
