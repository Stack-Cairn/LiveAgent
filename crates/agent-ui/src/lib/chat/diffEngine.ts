// The line-diff engine behind edit diffs (with its highlighter, ~220 kB) loads
// the first time a diff is shown, not with the chat (see EditDiffView.tsx).
import { lazyModule } from "../shared/lazyModule";

export type DiffEngine = typeof import("@git-diff-view/file");

export const diffEngine = lazyModule<DiffEngine>(() => import("@git-diff-view/file"));
