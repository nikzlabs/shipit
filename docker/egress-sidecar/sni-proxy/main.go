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
// Config (env):
//   EGRESS_PROXY_LISTEN        loopback addr to listen on (default 127.0.0.1:8443)
//   EGRESS_PROXY_ALLOWED       space-separated allowlist entries (".x.com" suffix or "x.com" exact)
//   EGRESS_PROXY_DECISION_URL  optional orchestrator endpoint for unknown hosts (Tier C allow-once);
//                              unset → unknown SNI is denied-fast (the safe default).
//   EGRESS_PROXY_SESSION_ID    session id, sent with decision queries
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
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		log.Fatalf("listen %s: %v", listenAddr, err)
	}
	log.Printf("listening on %s; %d allowlist entries; decision-url=%q", listenAddr, len(allowlist), decisionURL)
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

	up, err := net.DialTimeout("tcp", dst, 10*time.Second)
	if err != nil {
		log.Printf("dial upstream %s for %s: %v", dst, sni, err)
		return
	}
	defer up.Close()

	// Phase-2 hook (docs/172): an identity-validating proxy would inspect/verify
	// the request here — e.g. confirm an outbound token belongs to THIS user, not
	// an attacker — before forwarding. Left as a seam; Tier C only enforces SNI.
	validateIdentity(sni, up)

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

// validateIdentity is the Phase-2 seam (no-op in Tier C).
func validateIdentity(_ string, _ net.Conn) {}

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
