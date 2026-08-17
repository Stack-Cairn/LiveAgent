/// <reference types="vite/client" />
/// <reference types="unplugin-icons/types/react" />

declare const __LIVEAGENT_APP_VERSION__: string;

declare module "~icons/*?raw" {
  const svg: string;
  export default svg;
}
