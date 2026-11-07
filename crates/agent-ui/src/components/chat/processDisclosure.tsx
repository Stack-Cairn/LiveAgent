import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Transcript-wide default for the agent's process disclosures (the turn's work
 * trace, thinking segments and tool-trace groups). Off (the default) shows a
 * block open while it is live and folds it once it settles; on starts every
 * block expanded and stops settled ones from folding themselves back up. A
 * manual toggle still belongs to the user afterwards.
 */
const ExpandProcessByDefaultContext = createContext(false);

export function ProcessDisclosureProvider(props: {
  expandByDefault: boolean;
  /** The transcript's scroll-follow state; see ProcessViewportFollowingProvider. */
  isViewportFollowing?: () => boolean;
  children: ReactNode;
}) {
  const children = props.isViewportFollowing ? (
    <ProcessViewportFollowingProvider isFollowing={props.isViewportFollowing}>
      {props.children}
    </ProcessViewportFollowingProvider>
  ) : (
    props.children
  );
  return (
    <ExpandProcessByDefaultContext.Provider value={props.expandByDefault}>
      {children}
    </ExpandProcessByDefaultContext.Provider>
  );
}

export function useExpandProcessByDefault(): boolean {
  return useContext(ExpandProcessByDefaultContext);
}

/**
 * Calls `onChange` when the preference flips while the disclosure is mounted
 * (the desktop settings overlay leaves the transcript mounted underneath), so
 * rows already on screen follow the new default instead of only new ones. The
 * initial value is handled by each disclosure's own initial state.
 */
export function useProcessDefaultChange(
  expandByDefault: boolean,
  onChange: (expandByDefault: boolean) => void,
) {
  const previousRef = useRef(expandByDefault);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (previousRef.current === expandByDefault) return;
    previousRef.current = expandByDefault;
    onChangeRef.current(expandByDefault);
  }, [expandByDefault]);
}

const ALWAYS_FOLLOWING = () => true;

/**
 * Whether the transcript is pinned to its bottom. A block that settles while the
 * reader is scrolled up stays as it is: folding it would shift the text under
 * the reader (the virtualizer compensates a live row's shrink as if it happened
 * above the viewport). Hosts without a scroll-follow engine fold freely.
 */
const ProcessViewportFollowingContext = createContext<() => boolean>(ALWAYS_FOLLOWING);

export function ProcessViewportFollowingProvider(props: {
  isFollowing?: () => boolean;
  children: ReactNode;
}) {
  return (
    <ProcessViewportFollowingContext.Provider value={props.isFollowing ?? ALWAYS_FOLLOWING}>
      {props.children}
    </ProcessViewportFollowingContext.Provider>
  );
}

/**
 * Disclosure state for one live process block (a tool batch, a reasoning segment):
 *
 * - it mounts open while `live`, so the output is visible as it happens, and
 *   mounts folded once settled (history, finished turns);
 * - when it stops being live it folds itself, unless the user toggled it, the
 *   "expand process by default" preference is on, `keepOpenWhenSettled` holds
 *   (a failed batch keeps its error visible), an interaction still needs the
 *   user, or the reader is scrolled away from the bottom;
 * - a blocking interaction opens it once (see useAttentionDisclosure);
 * - flipping the preference is an explicit request and resets user ownership.
 */
export function useLiveProcessDisclosure(options: {
  live: boolean;
  keepOpenWhenSettled?: boolean;
  attentionRequired?: boolean;
}) {
  const { live, keepOpenWhenSettled = false, attentionRequired = false } = options;
  const expandByDefault = useExpandProcessByDefault();
  const isFollowing = useContext(ProcessViewportFollowingContext);
  const [open, setOpen] = useState(() => expandByDefault || live || attentionRequired);
  const userOwnsRef = useRef(false);
  const wasLiveRef = useRef(live);
  const settleRef = useRef({
    expandByDefault,
    keepOpenWhenSettled,
    attentionRequired,
    isFollowing,
  });
  settleRef.current = { expandByDefault, keepOpenWhenSettled, attentionRequired, isFollowing };

  useEffect(() => {
    const wasLive = wasLiveRef.current;
    wasLiveRef.current = live;
    if (wasLive === live || userOwnsRef.current) return;
    if (live) {
      setOpen(true);
      return;
    }
    const settle = settleRef.current;
    if (settle.expandByDefault || settle.keepOpenWhenSettled || settle.attentionRequired) return;
    if (!settle.isFollowing()) return;
    setOpen(false);
  }, [live]);

  useEffect(() => {
    if (attentionRequired) setOpen(true);
  }, [attentionRequired]);

  useProcessDefaultChange(expandByDefault, (expand) => {
    userOwnsRef.current = false;
    setOpen(expand || live || attentionRequired);
  });

  const toggle = useCallback(() => {
    userOwnsRef.current = true;
    setOpen((previous) => !previous);
  }, []);

  return [open, toggle] as const;
}
