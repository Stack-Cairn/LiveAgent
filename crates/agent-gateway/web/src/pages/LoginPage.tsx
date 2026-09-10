import {
  ArrowRight,
  History,
  Key,
  Lock,
  MessageSquareText,
  Shield,
  Timer,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";

type LoginPageProps = {
  token: string;
  error: string | null;
  isSubmitting: boolean;
  onTokenChange: (token: string) => void;
  onSubmit: () => void;
};

const features = [
  {
    icon: MessageSquareText,
    title: "Remote Chat",
    desc: "按桌面端式样查看 token、thinking、tool_call 与 tool_result。",
    accent:
      "[&>div:first-child]:bg-hsl-215-80-52-0p1 [&>div:first-child]:text-hsl-215-80-52 dark:[&>div:first-child]:bg-hsl-215-80-60-0p14 dark:[&>div:first-child]:text-hsl-215-80-70",
    entrance:
      "animate-[loginSlideUp_var(--ui-duration-400ms)_var(--ease-ui-enter)_var(--ui-duration-250ms)_both]",
  },
  {
    icon: History,
    title: "History Resume",
    desc: "从远程历史回填会话并继续对话，而不是只看原始 JSON。",
    accent:
      "[&>div:first-child]:bg-hsl-255-60-56-0p1 [&>div:first-child]:text-hsl-255-60-56 dark:[&>div:first-child]:bg-hsl-255-60-60-0p14 dark:[&>div:first-child]:text-hsl-255-60-72",
    entrance:
      "animate-[loginSlideUp_var(--ui-duration-400ms)_var(--ease-ui-enter)_var(--ui-duration-320ms)_both]",
  },
  {
    icon: Timer,
    title: "Cron Control",
    desc: "在浏览器里完成任务查看、创建、更新与删除的转发调试。",
    accent:
      "[&>div:first-child]:bg-hsl-32-90-48-0p1 [&>div:first-child]:text-hsl-32-90-48 dark:[&>div:first-child]:bg-hsl-32-80-50-0p14 dark:[&>div:first-child]:text-hsl-32-80-64",
    entrance:
      "animate-[loginSlideUp_var(--ui-duration-400ms)_var(--ease-ui-enter)_var(--ui-duration-390ms)_both]",
  },
];

export function LoginPage({ token, error, isSubmitting, onTokenChange, onSubmit }: LoginPageProps) {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <main className="relative grid min-h-100dvh place-items-center overflow-hidden bg-hsl-220-20-97 px-24px py-40px dark:bg-hsl-224-20-8 max-820:overflow-y-auto">
      {/* Subtle mesh gradient backdrop */}
      <div
        className="pointer-events-none fixed inset-0 z-0 bg-[radial-gradient(ellipse_80%_60%_at_20%_10%,var(--ui-color-hsl-210-100-92-0p6),transparent_60%),radial-gradient(ellipse_60%_50%_at_80%_20%,var(--ui-color-hsl-250-80-92-0p4),transparent_50%),radial-gradient(ellipse_50%_60%_at_60%_90%,var(--ui-color-hsl-200-60-92-0p3),transparent_50%)] dark:bg-[radial-gradient(ellipse_80%_60%_at_20%_10%,var(--ui-color-hsl-210-80-20-0p3),transparent_60%),radial-gradient(ellipse_60%_50%_at_80%_20%,var(--ui-color-hsl-250-60-24-0p2),transparent_50%),radial-gradient(ellipse_50%_60%_at_60%_90%,var(--ui-color-hsl-200-50-18-0p2),transparent_50%)]"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none fixed top-minus-120px left-minus-80px z-0 size-500px animate-login-backdrop-orb-1 rounded-half bg-hsl-210-100-88-0p5 opacity-(--ui-opacity-0p5) blur-80px motion-reduce:animate-none dark:bg-hsl-210-80-30-0p2 max-820:size-300px"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none fixed right-minus-60px bottom-minus-100px z-0 size-400px animate-login-backdrop-orb-2 rounded-half bg-hsl-250-70-88-0p4 opacity-(--ui-opacity-0p5) blur-80px motion-reduce:animate-none dark:bg-hsl-250-60-30-0p15 max-820:size-250px"
        aria-hidden="true"
      />

      <div className="relative z-1 grid grid-cols-login-container gap-0 w-login-container-w rounded-28px overflow-hidden border border-solid border-hsl-0-0-100-0p7 bg-hsl-0-0-100-0p55 backdrop-blur-40px backdrop-saturate-160 shadow-login-container dark:border-hsl-0-0-100-0p08 dark:bg-hsl-224-20-12-0p6 dark:shadow-login-container-2 max-1080:grid-cols-login-container-2 max-1080:w-login-container-w-2 max-820:rounded-22px max-640:rounded-20px max-640:w-full max-380:rounded-18px animate-login-entrance motion-reduce:animate-none">
        {/* Left: branding + features */}
        <div className="flex flex-col justify-center px-40px py-48px border-r border-solid border-r-hsl-0-0-0-0p04 bg-hsl-0-0-100-0p3 dark:border-r-hsl-0-0-100-0p05 dark:bg-hsl-0-0-100-0p02 max-1080:border-r-0 max-1080:border-r-current max-1080:border-b max-1080:border-solid max-1080:border-b-hsl-0-0-0-0p04 max-1080:px-32px max-1080:pt-36px max-1080:pb-28px dark:max-1080:border-b-hsl-0-0-100-0p05 max-820:px-24px max-820:pt-28px max-820:pb-20px max-640:px-20px max-640:pt-24px max-640:pb-18px max-380:px-16px max-380:pt-20px max-380:pb-14px animate-login-entrance-d1 motion-reduce:animate-none">
          <div className="flex items-center gap-12px max-380:gap-8px">
            <div className="flex size-40px shrink-0 items-center justify-center rounded-12px bg-primary text-primary-foreground shadow-[0_var(--spacing-2px)_var(--spacing-8px)_hsl(var(--primary)/0.2)] dark:shadow-[0_var(--spacing-2px)_var(--spacing-12px)_hsl(var(--primary)/0.3)] max-820:size-34px max-820:rounded-10px max-380:size-30px max-380:rounded-9px">
              <Shield size={18} strokeWidth={2} className="max-380:size-14px" />
            </div>
            <h1 className="m-0 text-28px font-bold leading-1p15 tracking-minus-0p035em text-foreground max-820:text-26px max-640:text-24px max-380:text-22px">
              LiveAgent Gateway
            </h1>
          </div>
          <p className="mx-0 mt-14px mb-0 text-14px leading-1p7 text-muted-foreground max-640:text-13px max-640:mt-10px max-380:text-12p5px max-380:leading-1p6">
            安全连接到远程代理会话，在浏览器中获得完整的控制台体验。
          </p>

          <div className="mt-32px flex animate-[loginSlideUp_var(--ui-duration-500ms)_var(--ease-ui-enter)_var(--ui-duration-200ms)_both] flex-col gap-10px motion-reduce:animate-none max-640:mt-20px max-640:gap-8px max-380:mt-16px max-380:gap-6px">
            {features.map((f) => (
              <div
                key={f.title}
                className={cn(
                  "flex items-start gap-12px rounded-14px border border-hsl-0-0-0-0p04 bg-hsl-0-0-100-0p5 px-14px py-12px transition-[background,border-color,transform] duration-200ms ease-default hover:translate-x-2px hover:border-hsl-0-0-0-0p06 hover:bg-hsl-0-0-100-0p75 motion-reduce:animate-none dark:border-hsl-0-0-100-0p06 dark:bg-hsl-0-0-100-0p04 dark:hover:border-hsl-0-0-100-0p1 dark:hover:bg-hsl-0-0-100-0p07 [&>div:first-child]:transition-transform [&>div:first-child]:duration-200ms [&>div:first-child]:ease-default hover:[&>div:first-child]:scale-[1.08] touch-primary:hover:translate-x-0 touch-primary:hover:border-hsl-0-0-0-0p04 touch-primary:hover:bg-hsl-0-0-100-0p5 touch-primary:active:bg-hsl-0-0-100-0p75 touch-primary:dark:hover:border-hsl-0-0-100-0p06 touch-primary:dark:hover:bg-hsl-0-0-100-0p04 touch-primary:dark:active:bg-hsl-0-0-100-0p07 touch-primary:hover:[&>div:first-child]:scale-100 max-820:rounded-12px max-820:px-12px max-820:py-10px max-640:items-center max-640:py-9px max-380:gap-10px max-380:rounded-10px max-380:px-10px max-380:py-8px",
                  f.accent,
                  f.entrance,
                )}
              >
                <div className="flex size-32px shrink-0 items-center justify-center rounded-9px max-820:size-28px max-820:rounded-8px max-380:size-26px max-380:rounded-7px">
                  <f.icon size={16} strokeWidth={2} />
                </div>
                <div className="min-w-0">
                  <strong className="block text-13px font-semibold mb-2px text-foreground max-640:text-12p5px max-640:mb-0">
                    {f.title}
                  </strong>
                  <span className="block text-11p5px leading-1p55 text-muted-foreground max-820:text-11px max-640:hidden">
                    {f.desc}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: auth form */}
        <div className="flex animate-[loginSlideUp_var(--ui-duration-500ms)_var(--ease-ui-enter)_var(--ui-duration-200ms)_both] items-center justify-center px-40px py-48px motion-reduce:animate-none max-1080:px-32px max-1080:pt-28px max-1080:pb-36px max-820:px-24px max-820:pt-20px max-820:pb-28px max-640:px-20px max-640:pt-18px max-640:pb-24px max-380:px-16px max-380:pt-14px max-380:pb-20px">
          <div className="w-full max-w-360px max-1080:max-w-full">
            <div className="mb-28px max-640:mb-20px max-380:mb-16px">
              <div className="flex items-center gap-10px">
                <div className="shrink-0 flex items-center justify-center size-34px rounded-10px text-muted-foreground bg-muted/60 border border-solid border-hsl-0-0-0-0p04 dark:bg-hsl-0-0-100-0p06 dark:border-hsl-0-0-100-0p06 max-820:size-30px max-820:rounded-9px max-380:size-28px max-380:rounded-8px">
                  <Lock size={16} strokeWidth={2} />
                </div>
                <h2 className="m-0 text-22px font-bold tracking-minus-0p02em text-foreground max-820:text-20px max-380:text-18px">
                  连接控制台
                </h2>
              </div>
              <p className="mx-0 mt-8px mb-0 text-13px leading-1p6 text-muted-foreground max-640:text-12p5px max-380:text-12px">
                输入 Gateway 服务端的 Access Token 以验证身份
              </p>
            </div>

            <div
              className={cn(
                "mb-16px px-16px py-14px rounded-16px border border-solid border-hsl-0-0-0-0p06 bg-hsl-0-0-100-0p55 transition-[border-color,box-shadow] duration-250ms ease-default dark:border-hsl-0-0-100-0p08 dark:bg-hsl-0-0-100-0p04 max-820:px-14px max-820:py-12px max-820:rounded-14px max-380:px-12px max-380:py-10px max-380:rounded-12px max-380:mb-12px",
                isFocused &&
                  "border-hsl-215-70-60-0p4 shadow-login-input-wrap-focus dark:border-hsl-215-60-55-0p5 dark:shadow-login-input-wrap--focus-2",
              )}
            >
              <label
                htmlFor="access-token"
                className="flex items-center gap-6px mb-10px text-11px font-semibold tracking-0p08em uppercase text-muted-foreground max-380:mb-8px max-380:text-10px"
              >
                <Key size={12} strokeWidth={2.5} />
                Access Token
              </label>
              <Textarea
                id="access-token"
                name="access_token"
                rows={3}
                value={token}
                placeholder=""
                disabled={isSubmitting}
                aria-invalid={error ? "true" : "false"}
                onChange={(e) => onTokenChange(e.target.value)}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                className="min-h-72px resize-none border-0 bg-transparent p-0 font-mono text-13px leading-1p6 text-foreground shadow-none focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none touch-primary:text-16px"
              />
            </div>

            {error && (
              <p className="mx-0 mt-0 mb-14px px-14px py-10px rounded-10px text-13px leading-1p5 text-hsl-0-72-50 bg-hsl-0-80-50-0p06 border border-solid border-hsl-0-80-50-0p1 dark:text-hsl-0-80-68 dark:bg-hsl-0-80-50-0p1 dark:border-hsl-0-80-50-0p15">
                {error}
              </p>
            )}

            <Button
              type="button"
              size="lg"
              disabled={token.trim() === "" || isSubmitting}
              onClick={onSubmit}
              className="h-46px w-full cursor-pointer gap-8px rounded-13px text-14px font-semibold transition-[transform,box-shadow,opacity] duration-200ms ease-default enabled:hover:-translate-y-1px enabled:hover:shadow-[0_var(--spacing-4px)_var(--spacing-20px)_hsl(var(--primary)/0.2)] enabled:active:translate-y-0 enabled:active:scale-[0.985] touch-primary:enabled:hover:translate-y-0 touch-primary:enabled:hover:shadow-none touch-primary:enabled:active:scale-[0.98]"
            >
              {isSubmitting ? (
                <span className="inline-block size-18px border-2 border-solid border-primary-foreground/30 border-t-primary-foreground rounded-half animate-login-btn-loading" />
              ) : (
                <>
                  进入 Gateway
                  <ArrowRight size={15} strokeWidth={2.2} />
                </>
              )}
            </Button>

            <p className="mt-16px text-center text-11p5px text-muted-foreground/60 max-640:text-11px max-380:mt-12px">
              Token 验证通过后将本地保存，下次自动登录
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
