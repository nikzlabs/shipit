// Egress Tier C — transparent SNI-peek proxy (docs/172 Gap 1, SHI-90).
//
// Runs as a long-lived sidecar in the agent's network namespace
// (`--network container:<agent> --cap-add NET_ADMIN`, like the Tier A/B
// sidecars). The installer REDIRECTs the agent's outbound :443 to this proxy's
// loopback listener (EXCEPT traffic owned by the proxy's own uid, so the proxy's
// upstream dials aren't re-redirected — the istio/cilium owner-match pattern).
//
// What it adds over Tier A/B (which match by destination IP): hostname-level
// HTTPS policy. It reads the SNI from the TLS ClientHello — in the CLEARTEXT
// handshake, with NO decryption and NO CA injection, so end-to-end TLS is
// preserved — checks it against the allowlist, and either splices the raw TLS
// stream to the original destination or rejects it. This closes the CDN
// co-tenancy gap: an allowlisted host and a non-allowlisted host sharing one CDN
// IP are indistinguishable to an ipset, but their SNI differs.
//
// SNI parsing reuses crypto/tls's own ClientHello parser (via a GetConfigForClient
// callback that captures ServerName and aborts the handshake) rather than a
// hand-rolled TLS parser — the bytes read during the peek are recorded and
// replayed to the upstream so the spliced stream is byte-for-byte intact.
//
// Phase 2 (SHI-90) — SNI-scoped identity validation for multi-tenant hosts.
//
// An allowlisted MULTI-TENANT host (S3, GCS, Azure Blob, a shared registry…)
// can still be abused for exfiltration: the host is approved, but the request
// targets the ATTACKER's bucket/account/org on it. The defining constraint here
// is that we do NOT decrypt TLS — SNI-peek only, no CA injection, E2E TLS stays
// intact (the whole premise of this proxy). So identity validation can use only
// signals available WITHOUT decryption: the SNI hostname, SO_ORIGINAL_DST, and a
// per-host rule. The HTTP path, query, and Authorization header — where path-style
// S3 (`s3.amazonaws.com/<bucket>/…`) and per-account API keys (e.g. an Anthropic
// workspace on `api.anthropic.com`) carry their identity — are encrypted and
// therefore OUT OF REACH. We do not, and must not, try to read them.
//
// What IS enforceable under SNI-only: tenant identity that surfaces as a DNS
// label in the SNI — i.e. VIRTUAL-HOSTED-style addressing, which most object
// stores use:
//
//	my-bucket.s3.amazonaws.com   my-bucket.s3.us-east-1.amazonaws.com
//	my-bucket.storage.googleapis.com   myaccount.blob.core.windows.net
//
// For a configured multi-tenant base host, validateIdentity extracts the tenant
// PREFIX (the labels of the SNI before the base) and permits the connection only
// if that prefix is one of this session's approved identities. The un-scoped APEX
// SNI (e.g. bare `s3.amazonaws.com`, used by path-style addressing where the
// bucket is in the encrypted path) is DENIED by default — allowing it would be a
// trivial bypass (just switch to path-style) — unless the operator explicitly
// opts in by listing an empty identity "". This is the honest boundary: we force
// tenant-in-SNI access and block the addressing modes whose identity we cannot
// see. See docs/172-agent-containment/egress-control.md "Phase 2".
//
// Config (env):
//
//	EGRESS_PROXY_LISTEN          loopback addr to listen on (default 127.0.0.1:8443)
//	EGRESS_PROXY_ALLOWED         space-separated allowlist entries (".x.com" suffix or "x.com" exact)
//	EGRESS_PROXY_DECISION_URL    optional orchestrator endpoint for unknown hosts (Tier C allow-once);
//	                             unset → unknown SNI is denied-fast (the safe default).
//	EGRESS_PROXY_SESSION_ID      session id, sent with decision queries
//	EGRESS_PROXY_IDENTITY_RULES  optional JSON array of per-host identity rules (Phase 2). Each:
//	                               {"host":".s3.amazonaws.com","identities":["my-bucket"]}
//	                             `host` is the multi-tenant base (leading-dot or exact, normalized
//	                             the same way as the allowlist); `identities` are the permitted
//	                             tenant prefixes (the SNI labels before the base). An empty
//	                             identity "" permits the un-scoped apex SNI (path-style; identity
//	                             NOT enforceable — opt-in). Unset/empty → no identity scoping (the
//	                             Tier C SNI allowlist decision stands unchanged). Malformed JSON is
//	                             logged and treated as no rules.
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

var (
	listenAddr  = envOr("EGRESS_PROXY_LISTEN", "127.0.0.1:8443")
	allowlist   = strings.Fields(os.Getenv("EGRESS_PROXY_ALLOWED"))
	decisionURL = os.Getenv("EGRESS_PROXY_DECISION_URL")
	sessionID   = os.Getenv("EGRESS_PROXY_SESSION_ID")

	// Phase-2 SNI-scoped identity rules. Parsed once in main() (after logging is
	// configured), then read-only — handle() goroutines only read it, so no lock.
	identityRules []identityRule

	errPeeked = errors.New("clienthello peeked")

	// Short positive/negative caches for orchestrator decisions so a retried
	// connection after an allow-once approval is picked up quickly without
	// re-querying on every packet, and a deny doesn't spam the card.
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
		// No SNI (not TLS, or SNI-less ClientHello). Deny — we can't apply a
		// hostname policy, and IP-only is already Tier A/B's job.
		log.Printf("deny: no SNI (dst %s)", dst)
		return
	}
	if !decide(sni) {
		log.Printf("deny: %s (dst %s)", sni, dst)
		return
	}

	// Phase-2 identity validation (docs/172, SHI-90). On a configured multi-tenant
	// host, permit only this session's approved tenant identity — extracted from
	// the SNI itself (no decryption). Deny-fast before dialing, like any other
	// deny: the attacker's bucket/account on an allowlisted host has nowhere to go.
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

	if _, err := up.Write(hello); err != nil { // replay the peeked ClientHello
		return
	}
	pipe(c, up)
}

// pipe splices two connections bidirectionally until either side closes.
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

// identityRule binds a multi-tenant base host to the set of tenant identities
// this session is allowed to reach on it. The tenant is the SNI label prefix
// before the base (e.g. "my-bucket" in "my-bucket.s3.amazonaws.com"); the empty
// prefix "" is the un-scoped apex (path-style), permitted only if listed.
type identityRule struct {
	base       string              // normalized multi-tenant base, e.g. "s3.amazonaws.com"
	identities map[string]struct{} // normalized permitted tenant prefixes
}

// rawIdentityRule is the on-the-wire JSON shape of EGRESS_PROXY_IDENTITY_RULES.
type rawIdentityRule struct {
	Host       string   `json:"host"`
	Identities []string `json:"identities"`
}

// parseIdentityRules parses EGRESS_PROXY_IDENTITY_RULES. Empty/unset → no rules.
// Malformed JSON is logged and treated as no rules (the orchestrator builds this
// value, so a parse error is a bug, not an attack — fail to "no identity scoping"
// rather than blackholing the whole session; the SNI allowlist still applies).
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

// normHost normalizes a hostname (or tenant prefix) for comparison: trim space,
// drop a single trailing dot, lowercase. Mirrors matchEntry / egress-allowlist.ts.
func normHost(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(s, ".")
	return strings.ToLower(strings.TrimSpace(s))
}

// identityBase normalizes a rule's `host` to its base form: a leading-dot entry
// (".s3.amazonaws.com") and an exact entry ("s3.amazonaws.com") both reduce to
// the same base — the leading dot only governs allowlist matching (handled by
// decide), not tenant extraction.
func identityBase(host string) string {
	return normHost(strings.TrimPrefix(strings.TrimSpace(host), "."))
}

// tenantPrefix returns the tenant portion of `sni` for a rule whose base is
// `base`, and whether the SNI belongs to that base at all:
//   - sni == base        → ("", true)            the un-scoped apex (path-style)
//   - sni == "<x>.base"  → ("<x>", true)         virtual-hosted tenant (x may hold dots)
//   - otherwise          → ("", false)           not governed by this base
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

// matchIdentityRule returns the most-specific (longest-base) identity rule that
// governs `sni`, or nil if no rule does.
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

// validateIdentity enforces SNI-scoped tenant identity on configured multi-tenant
// hosts (Phase 2, docs/172). It uses ONLY the SNI — no decryption. A host with no
// identity rule is unaffected (returns true; the Tier C SNI allowlist decision
// stands). For a governed host, the connection is permitted only if the SNI's
// tenant prefix is one of the session's approved identities; the un-scoped apex
// (path-style, identity not visible) is denied unless "" was explicitly listed.
func validateIdentity(sni string) bool {
	rule := matchIdentityRule(sni)
	if rule == nil {
		return true
	}
	tenant, ok := tenantPrefix(sni, rule.base)
	if !ok {
		return true // defensive: matchIdentityRule already confirmed it belongs
	}
	_, permitted := rule.identities[tenant]
	return permitted
}

// decide returns whether traffic to the given SNI is permitted: static allowlist
// first (fast path), then — only if a decision URL is configured (Tier C
// allow-once) — the orchestrator, which is the policy decision point and emits
// the allow-once card on a deny. With no decision URL, an unknown host is denied.
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

// matchEntry mirrors hostMatchesEntry in egress-allowlist.ts: a leading-dot entry
// (".x.com") matches the base AND any subdomain; an exact entry matches only
// itself. Look-alikes ("evilgithub.com" vs ".github.com") are rejected.
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
	ttl := 2 * time.Second // deny: short, so a retry after approval re-queries
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

// peekSNI reads the TLS ClientHello from c, extracts the SNI using crypto/tls's
// own parser, and returns the SNI plus the raw bytes read (to replay upstream).
func peekSNI(c net.Conn) (sni string, recorded []byte) {
	r := &recorder{conn: c, rec: true}
	cfg := &tls.Config{
		GetConfigForClient: func(chi *tls.ClientHelloInfo) (*tls.Config, error) {
			sni = chi.ServerName
			return nil, errPeeked // abort before any TLS termination
		},
	}
	_ = tls.Server(r, cfg).Handshake() // expected to fail with errPeeked
	r.rec = false
	return sni, r.buf
}

// recorder tees reads into buf during the peek (rec=true) and swallows writes
// (the aborted handshake's alert) so the client connection is left untouched.
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
		return len(p), nil // swallow the abort alert during peek
	}
	return r.conn.Write(p)
}
func (r *recorder) Close() error                       { return r.conn.Close() }
func (r *recorder) LocalAddr() net.Addr                { return r.conn.LocalAddr() }
func (r *recorder) RemoteAddr() net.Addr               { return r.conn.RemoteAddr() }
func (r *recorder) SetDeadline(t time.Time) error      { return r.conn.SetDeadline(t) }
func (r *recorder) SetReadDeadline(t time.Time) error  { return r.conn.SetReadDeadline(t) }
func (r *recorder) SetWriteDeadline(t time.Time) error { return r.conn.SetWriteDeadline(t) }

// originalDst recovers the pre-REDIRECT destination (ip:port) via SO_ORIGINAL_DST.
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
	port := int(addr.Port<<8) | int(addr.Port>>8) // ntohs
	return net.JoinHostPort(ip.String(), strconv.Itoa(port)), nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
