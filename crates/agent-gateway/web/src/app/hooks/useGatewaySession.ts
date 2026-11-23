import { errorMessageWithFallback } from "@liveagent/ui/lib/shared/value";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  GATEWAY_AUTH_ERROR_KEYS,
  normalizeGatewayAccessToken,
  verifyGatewayAccessToken,
} from "@/lib/gatewayAuth";
import { resetGatewaySocketClientIfLoaded } from "@/lib/gatewaySocketReset";
import { clearToken, loadToken, saveToken } from "@/lib/storage";

export type GatewaySession = ReturnType<typeof useGatewaySession>;

export function useGatewaySession(historyShareToken: string | null) {
  const initialStoredTokenRef = useRef(historyShareToken ? "" : loadToken());
  const [token, setToken] = useState("");
  const [loginToken, setLoginToken] = useState(initialStoredTokenRef.current);
  const [authSubmitting, setAuthSubmitting] = useState(
    () => normalizeGatewayAccessToken(initialStoredTokenRef.current) !== "",
  );
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const storedToken = normalizeGatewayAccessToken(initialStoredTokenRef.current);
    if (!storedToken) {
      return;
    }

    let cancelled = false;
    setAuthError(null);
    resetGatewaySocketClientIfLoaded();

    void verifyGatewayAccessToken(storedToken)
      .then((verifiedToken) => {
        if (cancelled) {
          return;
        }
        initialStoredTokenRef.current = verifiedToken;
        saveToken(verifiedToken);
        setLoginToken(verifiedToken);
        setToken(verifiedToken);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        initialStoredTokenRef.current = "";
        clearToken();
        resetGatewaySocketClientIfLoaded();
        setToken("");
        setAuthError(errorMessageWithFallback(error, GATEWAY_AUTH_ERROR_KEYS.failed));
        setLoginToken(storedToken);
      })
      .finally(() => {
        if (!cancelled) {
          setAuthSubmitting(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async () => {
    const draftToken = loginToken;
    const normalizedToken = normalizeGatewayAccessToken(draftToken);
    if (!normalizedToken) {
      setAuthError(GATEWAY_AUTH_ERROR_KEYS.required);
      return;
    }

    setAuthSubmitting(true);
    setAuthError(null);
    resetGatewaySocketClientIfLoaded();

    try {
      const verifiedToken = await verifyGatewayAccessToken(draftToken);
      initialStoredTokenRef.current = verifiedToken;
      saveToken(verifiedToken);
      setLoginToken(verifiedToken);
      setToken(verifiedToken);
    } catch (error) {
      initialStoredTokenRef.current = "";
      clearToken();
      resetGatewaySocketClientIfLoaded();
      setToken("");
      setAuthError(errorMessageWithFallback(error, GATEWAY_AUTH_ERROR_KEYS.failed));
    } finally {
      setAuthSubmitting(false);
    }
  }, [loginToken]);

  const clearSession = useCallback(() => {
    clearToken();
    resetGatewaySocketClientIfLoaded();
    initialStoredTokenRef.current = "";
    setAuthSubmitting(false);
    setAuthError(null);
    setLoginToken("");
    setToken("");
  }, []);

  return {
    token,
    loginToken,
    authSubmitting,
    authError,
    setToken,
    setLoginToken,
    setAuthError,
    login,
    clearSession,
  };
}
