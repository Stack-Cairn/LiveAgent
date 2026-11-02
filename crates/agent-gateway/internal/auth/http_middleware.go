package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
)

func HTTPMiddleware(expectedToken string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !ValidateBearerHeader(r.Header.Get("Authorization"), expectedToken) {
			if r.URL.Path == "/api/image" || strings.HasPrefix(r.URL.Path, "/api/image/") {
				writeImageAuthRequired(w)
				return
			}
			writeJSONError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func ValidateBearerHeader(headerValue, expectedToken string) bool {
	headerValue = strings.TrimSpace(headerValue)
	if headerValue == "" {
		return false
	}
	parts := strings.SplitN(headerValue, " ", 2)
	if len(parts) != 2 {
		return false
	}
	if !strings.EqualFold(parts[0], "Bearer") {
		return false
	}
	return ValidateToken(parts[1], expectedToken)
}

func ValidateToken(value, expectedToken string) bool {
	value = strings.TrimSpace(value)
	expectedToken = strings.TrimSpace(expectedToken)
	if value == "" || expectedToken == "" {
		return false
	}
	valueHash := sha256.Sum256([]byte(value))
	expectedHash := sha256.Sum256([]byte(expectedToken))
	return subtle.ConstantTimeCompare(valueHash[:], expectedHash[:]) == 1
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": message,
	})
}
