package server

import (
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/css"
	"golang.org/x/net/html"
)

const tunnelRewriteBodyMaxBytes = 4 * 1024 * 1024

// Keep the runtime as executable JavaScript so its DOM behavior can be tested
// directly. The very same bytes are used for HTML injection and CSP hashing.
//
//go:embed tunnel_runtime.js
var tunnelRuntimeScript string

type tunnelResponseRewriteKind int

const (
	tunnelResponseRewriteNone tunnelResponseRewriteKind = iota
	tunnelResponseRewriteHTML
	tunnelResponseRewriteCSS
)

func tunnelResponseRewriteKindFor(
	method string,
	status int,
	headers http.Header,
) tunnelResponseRewriteKind {
	if strings.EqualFold(strings.TrimSpace(method), http.MethodHead) {
		return tunnelResponseRewriteNone
	}
	if status < http.StatusOK ||
		status == http.StatusNoContent ||
		status == http.StatusNotModified {
		return tunnelResponseRewriteNone
	}
	if strings.TrimSpace(headers.Get("Content-Encoding")) != "" {
		return tunnelResponseRewriteNone
	}

	contentType := strings.TrimSpace(headers.Get("Content-Type"))
	if contentType == "" {
		return tunnelResponseRewriteNone
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType = contentType
	}
	mediaType = strings.ToLower(strings.TrimSpace(mediaType))

	switch mediaType {
	case "text/html", "application/xhtml+xml":
		return tunnelResponseRewriteHTML
	case "text/css":
		return tunnelResponseRewriteCSS
	default:
		return tunnelResponseRewriteNone
	}
}

func rewriteTunnelResponseBody(
	body []byte,
	rw tunnelRewrite,
	kind tunnelResponseRewriteKind,
) ([]byte, bool) {
	if len(body) == 0 || kind == tunnelResponseRewriteNone || rw.publicPrefix() == "" {
		return body, false
	}
	if !utf8.Valid(body) {
		return body, false
	}

	original := string(body)
	rewritten := original
	switch kind {
	case tunnelResponseRewriteHTML:
		rewritten = rewriteTunnelHTMLBody(rewritten, rw)
	case tunnelResponseRewriteCSS:
		rewritten = rewriteTunnelCSSBody(rewritten, rw)
	}
	if rewritten == original {
		return body, false
	}
	return []byte(rewritten), true
}

func rewriteTunnelHTMLBody(input string, rw tunnelRewrite) string {
	tokenizer := html.NewTokenizer(strings.NewReader(input))
	var builder strings.Builder
	changed := false
	injected := false
	shim := tunnelRuntimeBootstrapScript(rw)

	for {
		tokenType := tokenizer.Next()
		if tokenType == html.ErrorToken {
			if errors := tokenizer.Err(); errors != nil && errors != io.EOF {
				return input
			}
			break
		}

		raw := string(tokenizer.Raw())
		if tokenType != html.StartTagToken && tokenType != html.SelfClosingTagToken {
			builder.WriteString(raw)
			continue
		}

		token := tokenizer.Token()
		tagName := strings.ToLower(strings.TrimSpace(token.Data))
		if !injected && shim != "" && tagName == "script" {
			builder.WriteString(shim)
			injected = true
			changed = true
		}
		tokenChanged := false
		for index := range token.Attr {
			attr := &token.Attr[index]
			key := strings.ToLower(strings.TrimSpace(attr.Key))
			switch {
			case isTunnelHTMLURLAttribute(key):
				rewritten := rewriteTunnelBodyURL(attr.Val, rw)
				if rewritten != attr.Val {
					attr.Val = rewritten
					tokenChanged = true
				}
			case key == "style":
				rewritten := rewriteTunnelCSSBody(attr.Val, rw)
				if rewritten != attr.Val {
					attr.Val = rewritten
					tokenChanged = true
				}
			}
		}
		if tokenChanged {
			builder.WriteString(token.String())
			changed = true
		} else {
			builder.WriteString(raw)
		}
		if !injected && shim != "" && tagName == "head" {
			builder.WriteString(shim)
			injected = true
			changed = true
		}
	}

	if !injected && shim != "" {
		return shim + builder.String()
	}
	if !changed {
		return input
	}
	return builder.String()
}

func rewriteTunnelCSSBody(input string, rw tunnelRewrite) string {
	lexer := css.NewLexer(parse.NewInputString(input))
	var builder strings.Builder
	changed := false

	for {
		tokenType, data := lexer.Next()
		if tokenType == css.ErrorToken {
			if err := lexer.Err(); err != nil && err != io.EOF {
				return input
			}
			break
		}

		token := string(data)
		if tokenType == css.URLToken {
			if rewritten, ok := rewriteTunnelCSSURLToken(token, rw); ok {
				builder.WriteString(rewritten)
				changed = true
				continue
			}
		}
		builder.WriteString(token)
	}

	if !changed {
		return input
	}
	return builder.String()
}

func isTunnelHTMLURLAttribute(key string) bool {
	switch key {
	case "href", "src", "action", "poster", "data", "formaction", "xlink:href":
		return true
	default:
		return false
	}
}

func tunnelRuntimeBootstrapScript(rw tunnelRewrite) string {
	body := tunnelShimScriptBody(rw)
	if body == "" {
		return ""
	}
	return `<script data-liveagent-tunnel-shim>` + body + `</script>`
}

// tunnelShimScriptBody is the raw JS between the shim's script tags; CSP
// hash amendment must digest exactly this string.
func tunnelShimScriptBody(rw tunnelRewrite) string {
	prefix := rw.publicPrefix()
	if prefix == "" {
		return ""
	}
	config, err := json.Marshal(map[string]string{
		"basePath": prefix,
	})
	if err != nil {
		return ""
	}
	return strings.TrimSpace(tunnelRuntimeScript) + `(` + string(config) + `);`
}

func rewriteTunnelCSSURLToken(token string, rw tunnelRewrite) (string, bool) {
	openIndex := strings.Index(token, "(")
	closeIndex := strings.LastIndex(token, ")")
	if openIndex < 0 || closeIndex < openIndex {
		return token, false
	}

	before := token[:openIndex+1]
	inner := token[openIndex+1 : closeIndex]
	after := token[closeIndex:]
	leadingLen := len(inner) - len(strings.TrimLeft(inner, " \t\r\n\f"))
	trailingLen := len(inner) - len(strings.TrimRight(inner, " \t\r\n\f"))
	if leadingLen+trailingLen > len(inner) {
		return token, false
	}
	leading := inner[:leadingLen]
	trailing := inner[len(inner)-trailingLen:]
	value := inner[leadingLen : len(inner)-trailingLen]
	if value == "" {
		return token, false
	}

	quote := byte(0)
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		quote = value[0]
		value = value[1 : len(value)-1]
	}

	rewritten := rewriteTunnelBodyURL(value, rw)
	if rewritten == value {
		return token, false
	}
	if quote == 0 && !css.IsURLUnquoted([]byte(rewritten)) {
		quote = '"'
	}
	if quote != 0 {
		rewritten = string(quote) + rewritten + string(quote)
	}
	return before + leading + rewritten + trailing + after, true
}

func rewriteTunnelBodyURL(value string, rw tunnelRewrite) string {
	prefix := rw.publicPrefix()
	if prefix == "" {
		return value
	}
	trimmed := strings.TrimSpace(value)
	if trimmed == "" ||
		strings.HasPrefix(trimmed, "#") ||
		strings.HasPrefix(trimmed, "//") {
		return value
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return value
	}
	target, targetErr := rw.parseTarget()
	if parsed.IsAbs() {
		if targetErr != nil || target.Host == "" {
			return value
		}
		if !strings.EqualFold(parsed.Scheme, target.Scheme) ||
			!strings.EqualFold(parsed.Host, target.Host) {
			return value
		}
		path := stripTunnelTargetBasePath(parsed.EscapedPath(), target.EscapedPath())
		return appendTunnelURLQueryAndFragment(prefix+pathOrRoot(path), parsed)
	}
	if !strings.HasPrefix(trimmed, "/") {
		return value
	}
	if trimmed == prefix || strings.HasPrefix(trimmed, prefix+"/") {
		return value
	}

	path := parsed.EscapedPath()
	if targetErr == nil && target.Host != "" {
		path = stripTunnelTargetBasePath(path, target.EscapedPath())
	}
	return appendTunnelURLQueryAndFragment(prefix+pathOrRoot(path), parsed)
}

// tunnelRewrite carries the two facts body/header rewriting needs: which
// public prefix the tunnel is mounted under and which local target it fronts.
type tunnelRewrite struct {
	slug      string
	targetURL string
}

func (rw tunnelRewrite) publicPrefix() string {
	slug := strings.TrimSpace(rw.slug)
	if slug == "" {
		return ""
	}
	return "/t/" + slug
}

func (rw tunnelRewrite) parseTarget() (*url.URL, error) {
	return url.Parse(strings.TrimSpace(rw.targetURL))
}

// amendTunnelCSP makes the injected shim executable under the response's
// Content-Security-Policy. Hash-amendable policies get the shim's sha256;
// nonce/strict-dynamic policies cannot be amended without weakening them, so
// they are stripped with an explicit marker header instead.
func amendTunnelCSP(headers http.Header, shimScriptBody string) {
	policies := headers.Values("Content-Security-Policy")
	if len(policies) == 0 || strings.TrimSpace(shimScriptBody) == "" {
		return
	}
	digest := sha256.Sum256([]byte(shimScriptBody))
	hash := "'sha256-" + base64.StdEncoding.EncodeToString(digest[:]) + "'"

	amended := make([]string, 0, len(policies))
	for _, policy := range policies {
		lower := strings.ToLower(policy)
		if strings.Contains(lower, "'nonce-") || strings.Contains(lower, "'strict-dynamic'") {
			headers.Del("Content-Security-Policy")
			headers.Del("Content-Security-Policy-Report-Only")
			headers.Set("X-Liveagent-Tunnel-Csp", "stripped")
			return
		}
		amended = append(amended, amendTunnelCSPPolicy(policy, hash))
	}
	headers.Del("Content-Security-Policy")
	for _, policy := range amended {
		headers.Add("Content-Security-Policy", policy)
	}
}

func amendTunnelCSPPolicy(policy string, hash string) string {
	directives := strings.Split(policy, ";")
	scriptIndexes := make([]int, 0, 2)
	defaultIndex := -1
	for index, directive := range directives {
		fields := strings.Fields(directive)
		if len(fields) == 0 {
			continue
		}
		name := strings.ToLower(fields[0])
		switch name {
		case "script-src", "script-src-elem":
			scriptIndexes = append(scriptIndexes, index)
		case "default-src":
			defaultIndex = index
		}
	}
	targets := scriptIndexes
	if len(targets) == 0 {
		if defaultIndex < 0 {
			return policy // no script restriction to satisfy
		}
		targets = []int{defaultIndex}
	}
	for _, index := range targets {
		lower := strings.ToLower(directives[index])
		// A hash would re-disable 'unsafe-inline' on policies that rely on it.
		if strings.Contains(lower, "'unsafe-inline'") &&
			!strings.Contains(lower, "'sha") && !strings.Contains(lower, "'nonce-") {
			continue
		}
		directives[index] = strings.TrimRight(directives[index], " ") + " " + hash
	}
	return strings.Join(directives, ";")
}

func pathOrRoot(path string) string {
	if strings.TrimSpace(path) == "" {
		return "/"
	}
	return path
}

func appendTunnelURLQueryAndFragment(path string, parsed *url.URL) string {
	if parsed == nil {
		return path
	}
	if parsed.RawQuery != "" {
		path += "?" + parsed.RawQuery
	}
	if parsed.Fragment != "" {
		path += "#" + parsed.EscapedFragment()
	}
	return path
}
