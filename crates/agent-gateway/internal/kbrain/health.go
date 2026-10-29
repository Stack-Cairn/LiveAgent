package kbrain

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Health is the parsed /v1/health handshake. Rules follow
// docs/design/2026-10-26-kbrain-decoupled-updates.md section 3.1 and are shared
// with the desktop parsers through agent-ui/src/lib/kbrain/health-contract-vectors.json.
type Health struct {
	// Legacy is true when the backend predates structured health (no protocol).
	Legacy             bool
	ProtocolMinor      int64
	BuildVersion       string
	InstanceID         string
	CapabilityRevision *int64
	Capabilities       map[string]any
}

// ErrHealthContract marks a health body that contradicts or mistypes the contract.
var ErrHealthContract = errors.New("kbrain health contract violation")

// errHealthUnavailable marks a relay that answers /v1/health with 404. No
// contract is claimed, so nothing contradicts v1, but no capability is proven.
var errHealthUnavailable = errors.New("kbrain health endpoint is unavailable")

const (
	healthProtocolName  = "kbrain.agent"
	healthProtocolMajor = 1
)

func healthViolation(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrHealthContract, fmt.Sprintf(format, args...))
}

// maxSafeInteger is 2^53-1. TS hosts cannot tell 1 from 1.0 after JSON.parse,
// so every host judges integers by numeric value inside this range.
const maxSafeInteger = 1<<53 - 1

func nonNegativeInteger(value any) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(number.String(), 64)
	if err != nil || math.IsInf(f, 0) || f != math.Trunc(f) || f < 0 || f > maxSafeInteger {
		return 0, false
	}
	return int64(f), true
}

// optionalField treats a present field with the wrong type as a broken
// contract, never as missing.
func optionalField[T any](body map[string]any, key string, read func(any) (T, bool), expected string) (T, bool, error) {
	var zero T
	value, present := body[key]
	if !present {
		return zero, false, nil
	}
	out, ok := read(value)
	if !ok {
		return zero, false, healthViolation("%s must be %s", key, expected)
	}
	return out, true, nil
}

func healthString(value any) (string, bool) {
	s, ok := value.(string)
	return s, ok
}

func healthObject(value any) (map[string]any, bool) {
	m, ok := value.(map[string]any)
	return m, ok
}

// ParseHealth validates a raw health body. Only an absent protocol falls back to
// the legacy v1 path; null, strings or a contradicting name/major are rejected.
func ParseHealth(raw []byte) (Health, error) {
	if bytes.HasPrefix(raw, []byte{0xef, 0xbb, 0xbf}) {
		return Health{}, healthViolation("health body starts with a byte order mark")
	}
	if !utf8.Valid(raw) {
		return Health{}, healthViolation("health body is not valid UTF-8")
	}
	var decoded any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&decoded); err != nil {
		return Health{}, healthViolation("health body is not JSON: %v", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return Health{}, healthViolation("health body has trailing data")
	}
	body, ok := decoded.(map[string]any)
	if !ok {
		return Health{}, healthViolation("health body must be a JSON object")
	}
	if body["status"] != "ok" {
		return Health{}, healthViolation("status is %v, not \"ok\"", body["status"])
	}
	if body["version"] != protocolVersion {
		return Health{}, fmt.Errorf("%w: unsupported kbrain protocol %v", ErrHealthContract, body["version"])
	}
	health := Health{Legacy: true, Capabilities: map[string]any{}}
	if value, present := body["protocol"]; present {
		protocol, ok := value.(map[string]any)
		if !ok {
			return Health{}, healthViolation("protocol must be an object")
		}
		major, majorOK := nonNegativeInteger(protocol["major"])
		if protocol["name"] != healthProtocolName || !majorOK || major != healthProtocolMajor {
			return Health{}, healthViolation("protocol %v/%v contradicts %s", protocol["name"], protocol["major"], protocolVersion)
		}
		minor, ok := nonNegativeInteger(protocol["minor"])
		if !ok {
			return Health{}, healthViolation("protocol.minor must be a non-negative integer")
		}
		health.Legacy = false
		health.ProtocolMinor = minor
	}
	build, present, err := optionalField(body, "build", healthObject, "an object")
	if err != nil {
		return Health{}, err
	}
	if present {
		version, ok := build["version"].(string)
		if !ok || strings.TrimSpace(version) == "" {
			return Health{}, healthViolation("build.version must be a string")
		}
		for _, key := range []string{"revision", "channel"} {
			if _, _, err := optionalField(build, key, healthString, "a string"); err != nil {
				return Health{}, err
			}
		}
		health.BuildVersion = version
	}
	if _, _, err := optionalField(body, "startupContract", nonNegativeInteger, "a non-negative integer"); err != nil {
		return Health{}, err
	}
	if health.InstanceID, _, err = optionalField(body, "instanceId", healthString, "a string"); err != nil {
		return Health{}, err
	}
	revision, present, err := optionalField(body, "capabilityRevision", nonNegativeInteger, "a non-negative integer")
	if err != nil {
		return Health{}, err
	}
	if present {
		health.CapabilityRevision = &revision
	}
	capabilities, present, err := optionalField(body, "capabilities", healthObject, "an object")
	if err != nil {
		return Health{}, err
	}
	if present {
		health.Capabilities = capabilities
	}
	return health, nil
}

// FrozenCapability reports a historical capability that is fixed at exactly 1.
func (h Health) FrozenCapability(name string) bool {
	n, ok := nonNegativeInteger(h.Capabilities[name])
	return ok && n == 1
}

// CapabilityAtLeast compares monotonic integer capabilities such as session_changes.
func (h Health) CapabilityAtLeast(name string, minimum int64) bool {
	n, ok := nonNegativeInteger(h.Capabilities[name])
	return ok && n >= minimum
}

func (h Health) SupportsPermissionMode(mode string) bool {
	modes, ok := h.Capabilities["permission_modes"].([]any)
	return ok && slices.Contains(modes, any(mode))
}

// readHealth fetches and parses /v1/health. The response is returned so callers
// keep their existing status-code handling (for example 404 on old relays).
func readHealth(ctx context.Context, client *http.Client, baseURL, token string) (Health, *http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/health", nil)
	if err != nil {
		return Health{}, nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return Health{}, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		return Health{}, resp, fmt.Errorf("%w: %s", errHealthUnavailable, resp.Status)
	}
	if resp.StatusCode != http.StatusOK {
		return Health{}, resp, fmt.Errorf("kbrain health: %s", resp.Status)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Health{}, resp, err
	}
	health, err := ParseHealth(raw)
	return health, resp, err
}

func (c *Client) Health(ctx context.Context) (Health, *http.Response, error) {
	return readHealth(ctx, c.HTTP, c.BaseURL, c.Token)
}

// Handshake cache ages from docs/design/2026-10-26-kbrain-decoupled-updates.md
// section 9: a snapshot stays valid for 30s, and writes that depend on a
// capability revalidate once it is older than 5s. The probe gets its own short
// deadline so one hung health request cannot stall every run.
const (
	handshakeMaxAge           = 30 * time.Second
	handshakeCapabilityMaxAge = 5 * time.Second
	handshakeProbeTimeout     = 10 * time.Second
)

// verifiedHealth returns a handshake no older than maxAge for the current
// endpoint and token. Valid handshakes and 404 relays are cached; contract
// violations and transport failures never are, so a broken backend is
// re-checked (and rejected) on every request. A maxAge of zero always fetches.
// The lock only guards the cache: probes run outside it, so a waiting run
// always observes its own cancellation.
func (c *Client) verifiedHealth(ctx context.Context, maxAge time.Duration) (Health, error) {
	baseURL, token := c.BaseURL, c.Token
	c.handshakeMu.Lock()
	if c.handshakeURL == baseURL && c.handshakeToken == token && !c.handshakeAt.IsZero() && time.Since(c.handshakeAt) < maxAge {
		health, err := c.handshake, c.handshakeErr
		c.handshakeMu.Unlock()
		return health, err
	}
	generation := c.handshakeGen
	c.handshakeMu.Unlock()

	// The cache records when the probe started, so a slow response never
	// extends the window past what the backend actually reported.
	startedAt := time.Now()
	probeCtx, cancel := context.WithTimeout(ctx, handshakeProbeTimeout)
	defer cancel()
	health, _, err := readHealth(probeCtx, c.HTTP, baseURL, token)
	c.handshakeMu.Lock()
	switch {
	case errors.Is(err, ErrHealthContract):
		c.handshakeGen++
		c.handshakeAt = time.Time{}
	case (err == nil || errors.Is(err, errHealthUnavailable)) && generation == c.handshakeGen:
		c.handshake, c.handshakeErr = health, err
		c.handshakeURL, c.handshakeToken, c.handshakeAt = baseURL, token, startedAt
	case err != nil && c.handshakeURL == baseURL && c.handshakeToken == token:
		c.handshakeAt = time.Time{}
	}
	c.handshakeMu.Unlock()
	return health, err
}

func isElevatedPermissionMode(mode string) bool {
	return mode == "always" || mode == "auto_edit" || mode == "auto_review"
}

// requireHandshake gates every request that hands work to the backend. A
// contradicting backend is refused in every permission mode; relays that 404
// /v1/health claim no contract, so only modes needing no capability proceed.
func (c *Client) requireHandshake(ctx context.Context, mode string) error {
	elevated := isElevatedPermissionMode(mode)
	maxAge := handshakeMaxAge
	if elevated {
		maxAge = handshakeCapabilityMaxAge
	}
	health, err := c.verifiedHealth(ctx, maxAge)
	if elevated && (errors.Is(err, errHealthUnavailable) || (err == nil && !health.SupportsPermissionMode(mode))) {
		// Only positive capability answers come from the cache; a backend that
		// was just upgraded must not stay blocked for the cache lifetime.
		health, err = c.verifiedHealth(ctx, 0)
	}
	switch {
	case errors.Is(err, errHealthUnavailable) && !elevated:
		return nil
	case errors.Is(err, errHealthUnavailable):
		return fmt.Errorf("kbrain does not support permission mode %s; update the backend", mode)
	case err != nil:
		return err
	case elevated && !health.SupportsPermissionMode(mode):
		return fmt.Errorf("kbrain does not support permission mode %s; update the backend", mode)
	}
	return nil
}
