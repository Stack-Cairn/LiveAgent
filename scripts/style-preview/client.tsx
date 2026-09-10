import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../../crates/agent-ui/src/components/ui/button";
import { Input } from "../../crates/agent-ui/src/components/ui/input";
import { Textarea } from "../../crates/agent-ui/src/components/ui/textarea";
import { Badge } from "../../crates/agent-ui/src/components/ui/badge";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../crates/agent-ui/src/components/ui/tabs";
import { Skeleton } from "../../crates/agent-ui/src/components/ui/skeleton";
import { EmptyState } from "../../crates/agent-ui/src/components/ui/empty-state";
import { StepMarker } from "../../crates/agent-ui/src/components/settings/StepMarker";
import { ChoiceCard } from "../../crates/agent-ui/src/components/settings/ChoiceCard";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverClose,
} from "../../crates/agent-ui/src/components/ui/popover";
const params = new URLSearchParams(location.search),
  disabled = params.get("disabled") === "true";
function Sample({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <section data-case={name}>
      <h2>{name}</h2>
      <div data-sample>{children}</div>
    </section>
  );
}
function Gallery() {
  useEffect(() => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (params.get("focus") === "true")
          document.querySelector<HTMLInputElement>("input")?.focus();
        document.documentElement.dataset.ready = "true";
      }),
    );
  }, []);
  return (
    <main>
      {(["default", "secondary", "destructive", "outline", "ghost", "link"] as const).map(
        (variant) => (
          <Sample key={variant} name={"button-" + variant}>
            <Button variant={variant} disabled={disabled}>
              Action
            </Button>
          </Sample>
        ),
      )}
      {(["sm", "lg", "icon", "icon-sm", "icon-xs"] as const).map((size) => (
        <Sample key={size} name={"button-" + size}>
          <Button size={size} disabled={disabled} aria-label={size}>
            {size.startsWith("icon") ? "＋" : "Action"}
          </Button>
        </Sample>
      ))}
      <Sample name="input">
        <Input disabled={disabled} aria-label="Example input" placeholder="Placeholder" />
      </Sample>
      <Sample name="textarea">
        <Textarea disabled={disabled} aria-label="Example textarea" placeholder="Placeholder" />
      </Sample>
      <Sample name="badge-count">
        <Badge variant="muted" size="filter-count">
          12
        </Badge>
      </Sample>
      {(["default", "filter"] as const).map((variant) => (
        <Sample key={variant} name={"tabs-" + variant}>
          <Tabs defaultValue="first">
            <TabsList variant={variant} aria-label="Example tabs">
              <TabsTrigger value="first" disabled={disabled}>
                First
              </TabsTrigger>
              <TabsTrigger value="second" disabled={disabled}>
                Second
              </TabsTrigger>
              <TabsTrigger value="disabled" disabled>
                Disabled
              </TabsTrigger>
            </TabsList>
            <TabsContent value="first">First panel</TabsContent>
            <TabsContent value="second">Second panel</TabsContent>
          </Tabs>
        </Sample>
      ))}
      {(["shimmer", "pulse"] as const).map((variant) => (
        <Sample key={variant} name={"skeleton-" + variant}>
          <Skeleton variant={variant} className="h-4 w-full" />
        </Sample>
      ))}
      {(["workspace", "settings"] as const).map((variant) => (
        <Sample key={variant} name={"empty-" + variant}>
          <EmptyState variant={variant}>
            <span>Nothing here</span>
          </EmptyState>
        </Sample>
      ))}
      <Sample name="step-marker">
        <StepMarker>1</StepMarker>
      </Sample>
      <Sample name="choice-card">
        <ChoiceCard
          type="button"
          disabled={disabled}
          className="border-border/60 bg-background hover:border-border hover:bg-muted/20"
        >
          Choice
        </ChoiceCard>
      </Sample>
      <Sample name="popover">
        <Popover>
          <PopoverTrigger render={<Button disabled={disabled} variant="outline" />}>
            Open popover
          </PopoverTrigger>
          <PopoverContent>
            <p>Popover content</p>
            <PopoverClose render={<Button size="sm" />}>Close</PopoverClose>
          </PopoverContent>
        </Popover>
      </Sample>
      {["top", "bottom"].map(side => <Sample key={side} name={"confirm-exit-keyframe-" + side}><div className="confirm-action-popover-popup" data-side={side} style={{animation: "confirmPopoverOut 120ms linear both"}}>Exit keyframe</div></Sample>)}
      {["confirm-action-popover-popup", "label-tooltip-popup"].flatMap((kind) =>
        ["top", "bottom"].flatMap((side) =>
          ["open", "starting", "ending"].map((state) => (
            <Sample key={kind + side + state} name={kind + "-" + side + "-" + state}>
              <div
                className={kind}
                data-side={side}
                data-starting-style={state === "starting" ? "" : undefined}
                data-ending-style={state === "ending" ? "" : undefined}
                style={{ "--transform-origin": "center" } as React.CSSProperties}
              >
                Popup state
              </div>
            </Sample>
          )),
        ),
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Gallery />);
