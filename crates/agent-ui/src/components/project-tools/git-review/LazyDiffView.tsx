import { type ComponentProps, lazy, Suspense } from "react";
import { loadDiffHighlightGrammars } from "../../../lib/shared/diffHighlightGrammars";
import type {
  DiffContent as DiffContentImpl,
  DiffReviewCard as DiffReviewCardImpl,
} from "./DiffView";

// The highlighted diff viewer and its grammars only load when a diff is shown.
// Grammars are registered before the first render so every DiffFile built by
// the viewer highlights exactly as if they had been bundled eagerly.
const loadDiffView = () =>
  import("./DiffView").then(async (module) => {
    await loadDiffHighlightGrammars();
    return module;
  });

const LoadedDiffContent = lazy(() =>
  loadDiffView().then((module) => ({ default: module.DiffContent })),
);
const LoadedDiffReviewCard = lazy(() =>
  loadDiffView().then((module) => ({ default: module.DiffReviewCard })),
);

export function DiffContent(props: ComponentProps<typeof DiffContentImpl>) {
  return (
    <Suspense fallback={<div className="min-h-0 flex-1" />}>
      <LoadedDiffContent {...props} />
    </Suspense>
  );
}

export function DiffReviewCard(props: ComponentProps<typeof DiffReviewCardImpl>) {
  return (
    <Suspense fallback={<div className="min-h-0 flex-1" />}>
      <LoadedDiffReviewCard {...props} />
    </Suspense>
  );
}
