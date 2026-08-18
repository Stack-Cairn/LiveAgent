import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import { useState } from "react";
import { createRoot } from "react-dom/client";

type BrowserPathPromptOptions = {
  title: string;
  description: string;
  label: string;
  placeholder: string;
  inputId: string;
};

function BrowserPathPromptDialog(props: {
  options: BrowserPathPromptOptions;
  onResolve: (value: string | null) => void;
}) {
  const { options, onResolve } = props;
  const [value, setValue] = useState("");

  return (
    <Dialog open onOpenChange={(open) => !open && onResolve(null)}>
      <DialogContent className="max-w-md p-0" closeLabel="取消" showCloseButton>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const path = value.trim();
            if (path) onResolve(path);
          }}
        >
          <DialogHeader>
            <DialogTitle>{options.title}</DialogTitle>
            <DialogDescription className="mt-1 text-xs">{options.description}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-2 py-5">
            <Label htmlFor={options.inputId}>{options.label}</Label>
            <Input
              id={options.inputId}
              autoFocus
              className="font-mono"
              placeholder={options.placeholder}
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          </DialogBody>
          <DialogFooter className="bg-muted/20">
            <DialogActions>
              <Button type="button" variant="outline" onClick={() => onResolve(null)}>
                取消
              </Button>
              <Button type="submit" disabled={!value.trim()}>
                确认
              </Button>
            </DialogActions>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function promptPathInBrowser(options: BrowserPathPromptOptions): Promise<string | null> {
  if (typeof document === "undefined" || !document.body) return Promise.resolve(null);

  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      queueMicrotask(() => {
        root.unmount();
        host.remove();
        resolve(value);
      });
    };

    root.render(<BrowserPathPromptDialog options={options} onResolve={finish} />);
  });
}
