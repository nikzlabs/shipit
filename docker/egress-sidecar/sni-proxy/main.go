// Transparent SNI proxy for hostname and tenant-scoped HTTPS policy.
// It preserves end-to-end TLS and can inspect only ClientHello SNI.
//
// Config (env):
//
//	EGRESS_PROXY_LISTEN          loopback addr to listen on (default 127.0.0.1:8443)
//	EGRESS_PROXY_ALLOWED         space-separated allowlist entries (".x.com" suffix or "x.com" exact)
//	EGRESS_PROXY_DECISION_URL    optional orchestrator endpoint for unknown hosts (Tier C allow-once);
//	                             unset → unknown SNI is denied-fast (the safe default).
//	EGRESS_PROXY_SESSION_ID      session id, sent with decision queries
//	EGRESS_PROXY_DECISION_TOKEN  credential for the decision query (planning#371), sent as the
//	                             X-Shipit-Egress-Token header. Unset → the header is omitted,
//	                             which the orchestrator accepts only from the agent container.
//	EGRESS_PROXY_IDENTITY_RULES  optional JSON identity rules, for example:
//	                               {"host":".s3.amazonaws.com","identities":["my-bucket"]}
//	                             identities are SNI prefixes; "" permits the unscoped apex.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const soOriginalDst = 80 // SO_ORIGINAL_DST (linux/netfilter_ipv4.h)

// Keep in sync with EGRESS_DECISION_HEADER in egress-decision-auth.ts.
const decisionTokenHeader = "X-Shipit-Egress-Token"

var (
	listenAddr  = envOr("EGRESS_PROXY_LISTEN", "127.0.0.1:8443")
	allowlist   = strings.Fields(os.Getenv("EGRESS_PROXY_ALLOWED"))
	decisionURL = os.Getenv("EGRESS_PROXY_DECISION_URL")
	sessionID   = os.Getenv("EGRESS_PROXY_SESSION_ID")

	// Source IP cannot authenticate a proxy in the workload's network namespace.
	decisionToken = os.Getenv("EGRESS_PROXY_DECISION_TOKEN")

	// Parsed once, then read-only across handlers.
	identityRules []identityRule

	errPeeked = errors.New("clienthello peeked")

	// Short caches prevent repeated decision queries and allow quick approval retries.
	decCache   = map[string]decision{}
	decCacheMu sync.Mutex
)

type decision struct {
	allow   bool
	expires time.Time
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("[egress-proxy] ")
	identityRules = parseIdentityRules(os.Getenv("EGRESS_PROXY_IDENTITY_RULES"))
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		log.Fatalf("listen %s: %v", listenAddr, err)
	}
	log.Printf("listening on %s; %d allowlist entries; %d identity rule(s); decision-url=%q",
		listenAddr, len(allowlist), len(identityRules), decisionURL)
	for {
		c, err := ln.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			continue
		}
		go handle(c)
	}
}

func handle(c net.Conn) {
	defer c.Close()
	tc, ok := c.(*net.TCPConn)
	if !ok {
		return
	}
	dst, err := originalDst(tc)
	if err != nil {
		log.Printf("SO_ORIGINAL_DST: %v", err)
		return
	}

	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	sni, hello := peekSNI(c)
	_ = c.SetReadDeadline(time.Time{})

	if sni == "" {
		// Without SNI, no hostname policy can be applied.
		log.Printf("deny: no SNI (dst %s)", dst)
		return
	}
	if !decide(sni) {
		log.Printf("deny: %s (dst %s)", sni, dst)
		return
	}

	// Validate tenant identity before dialing.
	if !validateIdentity(sni) {
		log.Printf("deny: identity not permitted for %s (dst %s)", sni, dst)
		return
	}

	up, err := net.DialTimeout("tcp", dst, 10*time.Second)
	if err != nil {
		log.Printf("dial upstream %s for %s: %v", dst, sni, err)
		return
	}
	defer up.Close()

	if _, err := up.Write(hello); err != nil {
		return
	}
	pipe(c, up)
}

func pipe(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	cp := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(*net.TCPConn); ok {
			_ = cw.CloseWrite()
		}
	}
	go cp(a, b)
	go cp(b, a)
	wg.Wait()
}

type identityRule struct {
	base       string
	identities map[string]struct{}
}

type rawIdentityRule struct {
	Host       string   `json:"host"`
	Identities []string `json:"identities"`
}

// Invalid rules disable identity scoping but leave the SNI allowlist active.
func parseIdentityRules(raw string) []identityRule {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var parsed []rawIdentityRule
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		log.Printf("WARN: EGRESS_PROXY_IDENTITY_RULES is not valid JSON (%v) — no identity scoping applied", err)
		return nil
	}
	rules := make([]identityRule, 0, len(parsed))
	for _, p := range parsed {
		base := identityBase(p.Host)
		if base == "" {
			log.Printf("WARN: identity rule with empty host skipped")
			continue
		}
		ids := make(map[string]struct{}, len(p.Identities))
		for _, id := range p.Identities {
			ids[normHost(id)] = struct{}{}
		}
		rules = append(rules, identityRule{base: base, identities: ids})
	}
	return rules
}

func normHost(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(s, ".")
	return strings.ToLower(strings.TrimSpace(s))
}

func identityBase(host string) string {
	return normHost(strings.TrimPrefix(strings.TrimSpace(host), "."))
}

func tenantPrefix(sni, base string) (string, bool) {
	h := normHost(sni)
	if h == base {
		return "", true
	}
	if suffix := "." + base; strings.HasSuffix(h, suffix) {
		return strings.TrimSuffix(h, suffix), true
	}
	return "", false
}

// Prefer the most specific matching base.
func matchIdentityRule(sni string) *identityRule {
	var best *identityRule
	for i := range identityRules {
		r := &identityRules[i]
		if _, ok := tenantPrefix(sni, r.base); ok {
			if best == nil || len(r.base) > len(best.base) {
				best = r
			}
		}
	}
	return best
}

func validateIdentity(sni string) bool {
	rule := matchIdentityRule(sni)
	if rule == nil {
		return true
	}
	tenant, ok := tenantPrefix(sni, rule.base)
	if !ok {
		return true
	}
	_, permitted := rule.identities[tenant]
	return permitted
}

func decide(sni string) bool {
	if matchStatic(sni) {
		return true
	}
	if decisionURL == "" {
		return false
	}
	return queryDecision(sni)
}

func matchStatic(host string) bool {
	for _, e := range allowlist {
		if matchEntry(host, e) {
			return true
		}
	}
	return false
}

// A leading dot matches a base and its subdomains; other entries are exact.
func matchEntry(host, entry string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	entry = strings.ToLower(strings.TrimSpace(entry))
	if entry == "" {
		return false
	}
	if strings.HasPrefix(entry, ".") {
		base := entry[1:]
		return host == base || strings.HasSuffix(host, "."+base)
	}
	return host == entry
}

func queryDecision(sni string) bool {
	now := time.Now()
	decCacheMu.Lock()
	if d, ok := decCache[sni]; ok && now.Before(d.expires) {
		decCacheMu.Unlock()
		return d.allow
	}
	decCacheMu.Unlock()

	allow := fetchDecision(sni)
	ttl := 2 * time.Second
	if allow {
		ttl = 60 * time.Second
	}
	decCacheMu.Lock()
	decCache[sni] = decision{allow: allow, expires: now.Add(ttl)}
	decCacheMu.Unlock()
	return allow
}

func fetchDecision(sni string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	u := decisionURL + "?" + url.Values{"host": {sni}, "session": {sessionID}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return false
	}
	if decisionToken != "" {
		req.Header.Set(decisionTokenHeader, decisionToken)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var body struct {
		Allow bool `json:"allow"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&body); err != nil {
		return false
	}
	return body.Allow
}

func peekSNI(c net.Conn) (sni string, recorded []byte) {
	r := &recorder{conn: c, rec: true}
	cfg := &tls.Config{
		GetConfigForClient: func(chi *tls.ClientHelloInfo) (*tls.Config, error) {
			sni = chi.ServerName
			return nil, errPeeked
		},
	}
	_ = tls.Server(r, cfg).Handshake()
	r.rec = false
	return sni, r.buf
}

type recorder struct {
	conn net.Conn
	buf  []byte
	rec  bool
}

func (r *recorder) Read(p []byte) (int, error) {
	n, err := r.conn.Read(p)
	if r.rec && n > 0 {
		r.buf = append(r.buf, p[:n]...)
	}
	return n, err
}
func (r *recorder) Write(p []byte) (int, error) {
	if r.rec {
		return len(p), nil
	}
	return r.conn.Write(p)
}
func (r *recorder) Close() error                       { return r.conn.Close() }
func (r *recorder) LocalAddr() net.Addr                { return r.conn.LocalAddr() }
func (r *recorder) RemoteAddr() net.Addr               { return r.conn.RemoteAddr() }
func (r *recorder) SetDeadline(t time.Time) error      { return r.conn.SetDeadline(t) }
func (r *recorder) SetReadDeadline(t time.Time) error  { return r.conn.SetReadDeadline(t) }
func (r *recorder) SetWriteDeadline(t time.Time) error { return r.conn.SetWriteDeadline(t) }

func originalDst(c *net.TCPConn) (string, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return "", err
	}
	var addr syscall.RawSockaddrInet4
	var getErr error
	ctrlErr := raw.Control(func(fd uintptr) {
		size := uint32(unsafe.Sizeof(addr))
		_, _, errno := syscall.Syscall6(
			syscall.SYS_GETSOCKOPT, fd,
			uintptr(syscall.SOL_IP), soOriginalDst,
			uintptr(unsafe.Pointer(&addr)), uintptr(unsafe.Pointer(&size)), 0,
		)
		if errno != 0 {
			getErr = errno
		}
	})
	if ctrlErr != nil {
		return "", ctrlErr
	}
	if getErr != nil {
		return "", getErr
	}
	ip := net.IPv4(addr.Addr[0], addr.Addr[1], addr.Addr[2], addr.Addr[3])
	port := int(addr.Port<<8) | int(addr.Port>>8)
	return net.JoinHostPort(ip.String(), strconv.Itoa(port)), nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
