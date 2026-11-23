// Startup entry of the WebUI. It owns the session and renders the login screen
// and share links itself; the signed-in app shell (chat, sidebar, transport) is a
// separate chunk that loads once a token is being verified or submitted, so the
// login screen never downloads it. Keep this file's imports light: everything
// it imports statically is in the startup bundle (scripts/check-bundle-size.mjs).
import { ChunkLoadBoundary, retryableLazy } from "@liveagent/ui/components/OnDemand";
import { type Locale, LocaleContext, useLocaleContextValue } from "@liveagent/ui/i18n/index";
import {
  normalizeTheme,
  resolveEffectiveTheme,
  subscribeToSystemThemePreference,
} from "@liveagent/ui/lib/settings/themeAndMemory";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { Suspense, useEffect, useMemo, useState } from "react";
import { type GatewaySession, useGatewaySession } from "@/app/hooks/useGatewaySession";
import { SharedHistoryPage } from "@/app/lazySurfaces";
import { parseHistoryShareToken } from "@/lib/historyShare";
import { loadToken } from "@/lib/storage";
import { loadWebLocale, loadWebThemePreference } from "@/lib/webLocale";
import {
  GATEWAY_CHAT_FRAME_CLASS,
  GATEWAY_MAIN_BACKDROP_CLASS,
  GATEWAY_MAIN_SHELL_CLASS,
  GATEWAY_SHELL_CLASS,
} from "@/lib/webStyleClasses";
import { LoginPage } from "@/pages/LoginPage";
import { SettingsSyncLoading } from "@/pages/SettingsSyncLoading";

const loadGatewayApp = () => import("@/app/GatewayApp");
const GatewayApp = retryableLazy(async () => (await loadGatewayApp()).default);

/** Starts downloading the app shell; safe to call repeatedly. */
function preloadGatewayApp() {
  void loadGatewayApp().catch(() => {
    // The render path reports the failure with a retry.
  });
}

// The signed-in shell applies the saved theme itself; until it loads, the
// login screen follows the same browser preference.
function useStoredTheme() {
  const theme = useMemo(() => normalizeTheme(loadWebThemePreference()), []);
  const [systemVersion, setSystemVersion] = useState(0);
  useEffect(() => {
    if (theme !== "system") return;
    return subscribeToSystemThemePreference(() => setSystemVersion((version) => version + 1));
  }, [theme]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: system theme notifications intentionally invalidate the computed theme
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolveEffectiveTheme(theme) === "dark");
  }, [theme, systemVersion]);
}

// The same screen the shell shows while it syncs settings, so loading the shell
// and syncing read as one step.
function ShellLoading({ locale }: { locale: Locale }) {
  return (
    <div className={GATEWAY_SHELL_CLASS}>
      <main className={GATEWAY_MAIN_SHELL_CLASS}>
        <div className={GATEWAY_MAIN_BACKDROP_CLASS} />
        <div
          className={cn(
            GATEWAY_CHAT_FRAME_CLASS,
            "relative flex h-full min-h-0 min-w-0 flex-1 flex-col",
            "items-center justify-center max-820:h-full",
          )}
        >
          <SettingsSyncLoading locale={locale} />
        </div>
      </main>
    </div>
  );
}

function SignedInApp({ session, locale }: { session: GatewaySession; locale: Locale }) {
  const [, setAttempt] = useState(0);
  const Shell = GatewayApp.Component;
  return (
    <ChunkLoadBoundary
      className="min-h-100dvh"
      onRetry={() => {
        GatewayApp.retry();
        setAttempt((attempt) => attempt + 1);
      }}
    >
      <Suspense fallback={<ShellLoading locale={locale} />}>
        {/* The view obtains image identity from the authenticated server endpoint.
            No owner or selected backend is inferred from browser preferences. */}
        <Shell imageStudioIdentity={undefined} session={session} />
      </Suspense>
    </ChunkLoadBoundary>
  );
}

export default function App() {
  const historyShareToken = useMemo(() => parseHistoryShareToken(), []);
  const session = useGatewaySession(historyShareToken);
  const localeContextValue = useLocaleContextValue(useMemo(loadWebLocale, []));
  useStoredTheme();

  // A stored token is verified on load: fetch the shell alongside the check
  // so a returning user does not wait for both one after the other.
  useEffect(() => {
    if (!historyShareToken && loadToken().trim()) preloadGatewayApp();
  }, [historyShareToken]);

  if (historyShareToken) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <SharedHistoryPage token={historyShareToken} />
      </LocaleContext.Provider>
    );
  }

  if (session.token) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <SignedInApp session={session} locale={localeContextValue.locale} />
      </LocaleContext.Provider>
    );
  }

  const { authError, setAuthError, setLoginToken } = session;
  return (
    <LocaleContext.Provider value={localeContextValue}>
      <LoginPage
        token={session.loginToken}
        error={authError}
        isSubmitting={session.authSubmitting}
        onTokenChange={(nextToken) => {
          // Typing a token is the first sign of a login: start on the shell.
          if (nextToken.trim()) preloadGatewayApp();
          setLoginToken(nextToken);
          if (authError) setAuthError(null);
        }}
        onSubmit={() => {
          preloadGatewayApp();
          void session.login();
        }}
      />
    </LocaleContext.Provider>
  );
}
