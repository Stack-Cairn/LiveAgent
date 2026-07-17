package handler

import (
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/doyensec/safeurl"
)

type outboundHTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

var errUnsafeOutboundURL = errors.New("unsafe outbound URL")

type unsafeOutboundURLError struct {
	message string
}

func (e *unsafeOutboundURLError) Error() string {
	return e.message
}

func (e *unsafeOutboundURLError) Unwrap() error {
	return errUnsafeOutboundURL
}

var outboundAllowedPorts = buildOutboundAllowedPorts()

var outboundBlockedIPPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("255.255.255.255/32"),
	netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2001:2::/48"),
	netip.MustParsePrefix("2001:10::/28"),
	netip.MustParsePrefix("2001:20::/28"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"),
	netip.MustParsePrefix("5f00::/16"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

func buildOutboundAllowedPorts() []int {
	ports := make([]int, 65535)
	for i := range ports {
		ports[i] = i + 1
	}
	return ports
}

func newSafeOutboundHTTPClient(timeout time.Duration) outboundHTTPClient {
	return newSafeOutboundHTTPClientWithOptions(timeout, nil, validateSafeOutboundRedirect)
}

func newSafeOutboundHTTPClientWithOptions(
	timeout time.Duration,
	allowedIPs []netip.Addr,
	checkRedirect func(req *http.Request, via []*http.Request) error,
) outboundHTTPClient {
	config := safeurl.GetConfigBuilder().
		SetTimeout(timeout).
		SetAllowedSchemes("http", "https").
		SetAllowedPorts(outboundAllowedPorts...).
		SetCheckRedirect(checkRedirect).
		EnableIPv6(true).
		AllowSendingCredentials(false)
	if len(allowedIPs) > 0 {
		allowedIPStrings := make([]string, 0, len(allowedIPs))
		for _, ip := range allowedIPs {
			allowedIPStrings = append(allowedIPStrings, ip.String())
		}
		config.SetAllowedIPs(allowedIPStrings...)
	}
	return safeurl.Client(config.Build())
}

func validateSafeOutboundRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return &unsafeOutboundURLError{message: "too many redirects"}
	}
	if req == nil || req.URL == nil {
		return &unsafeOutboundURLError{message: "redirect URL is required"}
	}
	return validateParsedOutboundHTTPURL(req.URL)
}

func validateOutboundHTTPURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, &unsafeOutboundURLError{message: "url is required"}
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, &unsafeOutboundURLError{message: fmt.Sprintf("URL must be absolute: %v", err)}
	}
	if err := validateParsedOutboundHTTPURL(parsed); err != nil {
		return nil, err
	}
	return parsed, nil
}

func validateParsedOutboundHTTPURL(parsed *url.URL) error {
	if err := validateParsedOutboundHTTPURLShape(parsed); err != nil {
		return err
	}
	if hostIP, err := netip.ParseAddr(parsed.Hostname()); err == nil && isBlockedOutboundIP(hostIP) {
		return &unsafeOutboundURLError{message: "URL host resolves to a blocked IP range"}
	}
	return nil
}

func validateParsedOutboundHTTPURLShape(parsed *url.URL) error {
	if parsed == nil {
		return &unsafeOutboundURLError{message: "URL must be absolute"}
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return &unsafeOutboundURLError{message: fmt.Sprintf("only http and https URLs are supported, got %s", parsed.Scheme)}
	}
	if parsed.Host == "" || parsed.Hostname() == "" {
		return &unsafeOutboundURLError{message: "URL must include a valid host"}
	}
	if parsed.User != nil {
		return &unsafeOutboundURLError{message: "URL cannot include embedded credentials"}
	}
	return nil
}

func isBlockedOutboundIP(ip netip.Addr) bool {
	if !ip.IsValid() {
		return true
	}
	ip = ip.Unmap()
	for _, prefix := range outboundBlockedIPPrefixes {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}

func isSafeOutboundBlockedError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, errUnsafeOutboundURL) {
		return true
	}
	var allowedIP *safeurl.AllowedIPError
	if errors.As(err, &allowedIP) {
		return true
	}
	var allowedPort *safeurl.AllowedPortError
	if errors.As(err, &allowedPort) {
		return true
	}
	var allowedScheme *safeurl.AllowedSchemeError
	if errors.As(err, &allowedScheme) {
		return true
	}
	var allowedHost *safeurl.AllowedHostError
	if errors.As(err, &allowedHost) {
		return true
	}
	var invalidHost *safeurl.InvalidHostError
	if errors.As(err, &invalidHost) {
		return true
	}
	var credentials *safeurl.SendingCredentialsBlockedError
	if errors.As(err, &credentials) {
		return true
	}
	return false
}
