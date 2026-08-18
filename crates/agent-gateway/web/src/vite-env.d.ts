/// <reference types="vite/client" />
/// <reference types="unplugin-icons/types/react" />

declare module "~icons/*?raw" {
  const svg: string;
  export default svg;
}
