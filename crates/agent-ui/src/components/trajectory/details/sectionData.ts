import {
  type LedgerHeader,
  TRAJECTORY_SECTION_SLOTS,
  type TrajectorySection,
} from "../../../lib/trajectory/types";

export function sectionContentAt(
  header: LedgerHeader | undefined,
  index: number,
  sectionById: ReadonlyMap<string, TrajectorySection>,
): string | undefined {
  const ref = header?.sections[index] ?? null;
  return ref === null ? undefined : sectionById.get(ref)?.content;
}

export function toolCatalogContent(
  header: LedgerHeader | undefined,
  sectionById: ReadonlyMap<string, TrajectorySection>,
): string | undefined {
  return sectionContentAt(header, TRAJECTORY_SECTION_SLOTS.indexOf("toolCatalog"), sectionById);
}

export function toolSchemaFromCatalog(
  content: string | undefined,
  toolName: string | undefined,
): string | undefined {
  if (content === undefined || toolName === undefined) return undefined;
  try {
    const catalog = JSON.parse(content) as unknown;
    if (!Array.isArray(catalog)) return undefined;
    const tool = catalog.find(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { name?: unknown }).name === toolName,
    );
    return tool === undefined ? undefined : JSON.stringify(tool, null, 2);
  } catch {
    return undefined;
  }
}
