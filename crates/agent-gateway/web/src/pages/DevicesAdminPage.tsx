import { ArrowLeft } from "@/components/icons";

import { DevicesSection } from "./settings/DevicesSection";

// 保留可直接访问的管理路由；WebUI 日常入口位于设置页内，并与此处复用同一内容组件。
export function DevicesAdminPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-6 sm:px-6">
      <a
        href="/"
        className="mb-5 flex w-fit items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        返回聊天
      </a>
      <DevicesSection />
    </div>
  );
}
