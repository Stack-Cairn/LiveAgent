import { createDomTestEnv } from "./dom-test-env.mjs";

export async function createToastTestEnv() {
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: {
    "../IconSet": { AlertTriangle: icon, CheckCircle2: icon, X: icon, XCircle: icon },
    "../../i18n/index": { useLocale: () => ({ t: key => key }) },
    "motion/react": { useReducedMotion: () => true },
  }});
  const { Toaster } = env.loadModule("@liveagent/ui/components/ui/toaster.tsx");
  const { toast } = env.loadModule("@liveagent/ui/components/ui/toast-manager.ts");
  const host = document.createElement("div"); document.body.append(host);
  const root = env.createRoot(host);
  const mount = async children => env.act(async () => root.render(env.React.createElement(env.React.StrictMode, null,
    env.React.createElement(Toaster), children)));
  const cleanup = async () => {
    await env.act(async () => { toast.dismiss(); root.unmount(); });
    host.remove(); env.cleanup();
  };
  return { ...env, toast, root, mount, cleanup };
}
