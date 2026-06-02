const WORKSPACE_IMAGE_EXTENSIONS = new Set([
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

export function isWorkspaceImagePath(path: string) {
  const normalized = path.trim().replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex < 0) return false;
  return WORKSPACE_IMAGE_EXTENSIONS.has(name.slice(extensionIndex + 1).toLowerCase());
}
