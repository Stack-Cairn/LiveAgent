import { createContext, type ReactNode, useContext, useEffect, useRef } from "react";

/**
 * Transcript-wide default for the agent's process disclosures (the turn's work
 * trace, thinking segments and tool-trace groups). Off keeps the compact folded
 * rows; on starts them expanded and stops settled ones from folding themselves
 * back up. A manual toggle still belongs to the user afterwards.
 */
const ExpandProcessByDefaultContext = createContext(false);

export function ProcessDisclosureProvider(props: {
  expandByDefault: boolean;
  children: ReactNode;
}) {
  return (
    <ExpandProcessByDefaultContext.Provider value={props.expandByDefault}>
      {props.children}
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
