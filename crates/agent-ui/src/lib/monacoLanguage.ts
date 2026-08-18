export type MonacoLanguageRegistration = {
  id: string;
  extensions?: readonly string[];
  filenames?: readonly string[];
};

const LIVEAGENT_LANGUAGE_REGISTRATIONS: readonly MonacoLanguageRegistration[] = [
  { id: "json", extensions: [".jsonc"] },
  { id: "makefile", filenames: ["Makefile"] },
  { id: "scss", extensions: [".sass"] },
  { id: "shell", extensions: [".zsh"] },
  { id: "toml", extensions: [".toml"], filenames: ["Cargo.lock"] },
];

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function resolveMonacoLanguageForPath(
  path: string,
  registrations: readonly MonacoLanguageRegistration[],
) {
  const name = basename(path).toLowerCase();
  const languages = [...LIVEAGENT_LANGUAGE_REGISTRATIONS, ...registrations];
  for (const language of languages) {
    if (language.filenames?.some((filename) => filename.toLowerCase() === name)) {
      return language.id;
    }
  }

  let bestMatch: { id: string; length: number } | null = null;
  for (const language of languages) {
    for (const extension of language.extensions ?? []) {
      const normalizedExtension = extension.toLowerCase();
      if (!name.endsWith(normalizedExtension)) continue;
      if (!bestMatch || normalizedExtension.length > bestMatch.length) {
        bestMatch = { id: language.id, length: normalizedExtension.length };
      }
    }
  }
  return bestMatch?.id ?? "plaintext";
}
