import type { ImageStudioPageProps } from "../features/image-studio/ImageStudioPage";

/** Host-owned I/O and identity, injected from the application root. */
export type ImageStudioHost = ImageStudioPageProps & {
  /** Changes when workspace/identity changes; resets UI and its subscriptions. */
  scopeKey: string;
};
