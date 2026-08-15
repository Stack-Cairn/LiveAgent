import { useCallback, useEffect, useRef, useState } from "react";

import { normalizeGatewayAccessToken, verifyGatewayAccessToken } from "@/lib/gatewayAuth";
import { clearGatewayOrigin, DEFAULT_GATEWAY_URL, setGatewayOrigin } from "@/lib/gatewayOrigin";
import { resetGatewayWebSocketClient } from "@/lib/gatewaySocket";
import { clearToken, loadGatewayUrl, loadToken, saveToken } from "@/lib/storage";

import { asErrorMessage } from "../chatEventUtils";

export function useGatewaySession(historyShareToken: string | null) {
  const initialStoredTokenRef = useRef(historyShareToken ? "" : loadToken());
  const initialStoredGatewayUrlRef = useRef(historyShareToken ? "" : loadGatewayUrl());
  const [token, setToken] = useState("");
  const [loginToken, setLoginToken] = useState(initialStoredTokenRef.current);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [loginGatewayUrl, setLoginGatewayUrl] = useState(
    initialStoredGatewayUrlRef.current || (historyShareToken ? "" : DEFAULT_GATEWAY_URL),
  );
  const [authSubmitting, setAuthSubmitting] = useState(
    () =>
      normalizeGatewayAccessToken(initialStoredTokenRef.current) !== "" &&
      initialStoredGatewayUrlRef.current.trim() !== "",
  );
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const storedToken = normalizeGatewayAccessToken(initialStoredTokenRef.current);
    const storedGatewayUrl = initialStoredGatewayUrlRef.current.trim();
    // A token from before the Gateway URL field existed (or one cleared
    // independently) has nothing to verify against; fall back to the login
    // form instead of guessing an origin.
    if (!storedToken || !storedGatewayUrl) {
      return;
    }

    let cancelled = false;
    setAuthError(null);
    resetGatewayWebSocketClient();

    void (async () => {
      try {
        const normalizedUrl = setGatewayOrigin(storedGatewayUrl);
        const verifiedToken = await verifyGatewayAccessToken(storedToken);
        if (cancelled) {
          return;
        }
        initialStoredTokenRef.current = verifiedToken;
        saveToken(verifiedToken);
        setLoginToken(verifiedToken);
        setToken(verifiedToken);
        setLoginGatewayUrl(normalizedUrl);
        setGatewayUrl(normalizedUrl);
      } catch (error) {
        if (cancelled) {
          return;
        }
        initialStoredTokenRef.current = "";
        clearToken();
        clearGatewayOrigin();
        resetGatewayWebSocketClient();
        setToken("");
        setGatewayUrl("");
        setAuthError(asErrorMessage(error, "Access Token 验证失败。"));
        setLoginToken(storedToken);
      } finally {
        if (!cancelled) {
          setAuthSubmitting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async () => {
    const draftToken = loginToken;
    const draftGatewayUrl = loginGatewayUrl;
    const normalizedToken = normalizeGatewayAccessToken(draftToken);
    if (!normalizedToken) {
      setAuthError("请输入 Access Token。");
      return;
    }
    if (!draftGatewayUrl.trim()) {
      setAuthError("请输入 Gateway 地址。");
      return;
    }

    setAuthSubmitting(true);
    setAuthError(null);
    resetGatewayWebSocketClient();

    try {
      const normalizedUrl = setGatewayOrigin(draftGatewayUrl);
      const verifiedToken = await verifyGatewayAccessToken(draftToken);
      initialStoredTokenRef.current = verifiedToken;
      saveToken(verifiedToken);
      setLoginToken(verifiedToken);
      setToken(verifiedToken);
      setLoginGatewayUrl(normalizedUrl);
      setGatewayUrl(normalizedUrl);
    } catch (error) {
      initialStoredTokenRef.current = "";
      clearToken();
      clearGatewayOrigin();
      resetGatewayWebSocketClient();
      setToken("");
      setGatewayUrl("");
      setAuthError(asErrorMessage(error, "Access Token 验证失败。"));
    } finally {
      setAuthSubmitting(false);
    }
  }, [loginToken, loginGatewayUrl]);

  const clearSession = useCallback(() => {
    clearToken();
    clearGatewayOrigin();
    resetGatewayWebSocketClient();
    initialStoredTokenRef.current = "";
    setAuthSubmitting(false);
    setAuthError(null);
    setLoginToken("");
    setToken("");
    setLoginGatewayUrl(DEFAULT_GATEWAY_URL);
    setGatewayUrl("");
  }, []);

  return {
    token,
    loginToken,
    gatewayUrl,
    loginGatewayUrl,
    authSubmitting,
    authError,
    setToken,
    setLoginToken,
    setLoginGatewayUrl,
    setAuthError,
    login,
    clearSession,
  };
}
