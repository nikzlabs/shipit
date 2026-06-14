// Tests for the Tier C SNI proxy. Focus: Phase-2 SNI-scoped identity validation
// (docs/172, SHI-90) and the supporting allowlist/SNI-peek primitives. These are
// pure unit tests — no netns, no iptables — plus one end-to-end peekSNI test over
// a real loopback TLS handshake.
package main

import (
	"crypto/tls"
	"net"
	"testing"
	"time"
)

func TestMatchEntry(t *testing.T) {
	cases := []struct {
		host, entry string
		want        bool
	}{
		{"github.com", ".github.com", true},
		{"api.github.com", ".github.com", true},
		{"API.GitHub.com", ".github.com", true},  // case-insensitive
		{"api.github.com.", ".github.com", true}, // trailing dot
		{"evilgithub.com", ".github.com", false}, // look-alike rejected
		{"github.com.evil.com", ".github.com", false},
		{"github.com", "github.com", true},      // exact
		{"api.github.com", "github.com", false}, // exact does not match subdomain
		{"", ".github.com", false},
		{"github.com", "", false},
	}
	for _, c := range cases {
		if got := matchEntry(c.host, c.entry); got != c.want {
			t.Errorf("matchEntry(%q,%q)=%v want %v", c.host, c.entry, got, c.want)
		}
	}
}

func TestParseIdentityRules(t *testing.T) {
	// Empty / whitespace → no rules.
	if r := parseIdentityRules(""); r != nil {
		t.Errorf("empty → %v want nil", r)
	}
	if r := parseIdentityRules("   "); r != nil {
		t.Errorf("whitespace → %v want nil", r)
	}
	// Malformed JSON → no rules (logged, not fatal).
	if r := parseIdentityRules("{not json"); r != nil {
		t.Errorf("malformed → %v want nil", r)
	}
	// Valid: leading-dot and exact host both normalize to the same base; identities
	// are normalized (lowercased, trailing dot dropped).
	rules := parseIdentityRules(`[
		{"host":".s3.amazonaws.com","identities":["My-Bucket","other"]},
		{"host":"blob.core.windows.net","identities":["myaccount"]},
		{"host":"","identities":["ignored"]}
	]`)
	if len(rules) != 2 {
		t.Fatalf("got %d rules want 2 (empty-host rule skipped)", len(rules))
	}
	if rules[0].base != "s3.amazonaws.com" {
		t.Errorf("base[0]=%q want s3.amazonaws.com", rules[0].base)
	}
	if _, ok := rules[0].identities["my-bucket"]; !ok {
		t.Errorf("identity %q not normalized into the set", "My-Bucket")
	}
	if rules[1].base != "blob.core.windows.net" {
		t.Errorf("base[1]=%q want blob.core.windows.net", rules[1].base)
	}
}

func TestTenantPrefix(t *testing.T) {
	cases := []struct {
		sni, base  string
		wantTenant string
		wantOK     bool
	}{
		{"my-bucket.s3.amazonaws.com", "s3.amazonaws.com", "my-bucket", true},
		{"s3.amazonaws.com", "s3.amazonaws.com", "", true},                    // apex
		{"MY-BUCKET.S3.amazonaws.com", "s3.amazonaws.com", "my-bucket", true}, // case
		{"a.b.s3.amazonaws.com", "s3.amazonaws.com", "a.b", true},             // multi-label prefix
		{"github.com", "s3.amazonaws.com", "", false},                         // unrelated
		{"evil-s3.amazonaws.com", "s3.amazonaws.com", "", false},              // not a real subdomain
	}
	for _, c := range cases {
		gotT, gotOK := tenantPrefix(c.sni, c.base)
		if gotT != c.wantTenant || gotOK != c.wantOK {
			t.Errorf("tenantPrefix(%q,%q)=(%q,%v) want (%q,%v)", c.sni, c.base, gotT, gotOK, c.wantTenant, c.wantOK)
		}
	}
}

func TestValidateIdentity(t *testing.T) {
	// No rules configured → everything passes (Tier C behavior unchanged).
	identityRules = nil
	for _, sni := range []string{"my-bucket.s3.amazonaws.com", "github.com", "s3.amazonaws.com"} {
		if !validateIdentity(sni) {
			t.Errorf("with no rules, validateIdentity(%q)=false want true", sni)
		}
	}

	// One rule: only `my-bucket` permitted on .s3.amazonaws.com; apex not opted in.
	identityRules = parseIdentityRules(`[{"host":".s3.amazonaws.com","identities":["my-bucket"]}]`)
	cases := []struct {
		sni  string
		want bool
	}{
		{"my-bucket.s3.amazonaws.com", true},           // approved tenant
		{"MY-BUCKET.s3.amazonaws.com", true},           // case-insensitive
		{"attacker.s3.amazonaws.com", false},           // attacker's bucket on the same host → blocked
		{"s3.amazonaws.com", false},                    // un-scoped apex (path-style) → blocked (can't see bucket)
		{"github.com", true},                           // host not governed by any rule → unaffected
		{"my-bucket.s3.us-east-1.amazonaws.com", true}, // not under .s3.amazonaws.com base → ungoverned, allowed
	}
	for _, c := range cases {
		if got := validateIdentity(c.sni); got != c.want {
			t.Errorf("validateIdentity(%q)=%v want %v", c.sni, got, c.want)
		}
	}

	// Apex opt-in: listing "" permits the un-scoped host (operator accepts that
	// path-style identity is not enforceable under SNI-only).
	identityRules = parseIdentityRules(`[{"host":".s3.amazonaws.com","identities":["my-bucket",""]}]`)
	if !validateIdentity("s3.amazonaws.com") {
		t.Errorf("apex with \"\" opt-in should be permitted")
	}
	if validateIdentity("attacker.s3.amazonaws.com") {
		t.Errorf("apex opt-in must not widen tenant scoping")
	}

	identityRules = nil // restore
}

func TestMatchIdentityRuleMostSpecific(t *testing.T) {
	// A broad rule and a more-specific rule overlap; the most-specific (longest
	// base) governs. Regional S3 is scoped tighter than the global base.
	identityRules = parseIdentityRules(`[
		{"host":".amazonaws.com","identities":["wide"]},
		{"host":".s3.us-east-1.amazonaws.com","identities":["narrow"]}
	]`)
	defer func() { identityRules = nil }()

	r := matchIdentityRule("narrow.s3.us-east-1.amazonaws.com")
	if r == nil || r.base != "s3.us-east-1.amazonaws.com" {
		t.Fatalf("expected the longest-base rule to win, got %+v", r)
	}
	if !validateIdentity("narrow.s3.us-east-1.amazonaws.com") {
		t.Errorf("approved tenant under the specific rule should pass")
	}
	if validateIdentity("wide.s3.us-east-1.amazonaws.com") {
		t.Errorf("the narrow rule governs; %q is not in its identities", "wide")
	}
	// A host under only the broad rule still uses it (tenant prefix == "wide").
	if !validateIdentity("wide.amazonaws.com") {
		t.Errorf("broad rule should govern hosts the specific rule does not cover")
	}
	// Under the broad rule, a multi-label tenant prefix is NOT the bare "wide".
	if validateIdentity("wide.ec2.amazonaws.com") {
		t.Errorf("tenant prefix %q != %q; should not match", "wide.ec2", "wide")
	}
}

// TestPeekSNI drives peekSNI with a real TLS ClientHello over loopback to confirm
// it extracts the ServerName without terminating TLS and records the handshake
// bytes (which the proxy replays upstream).
func TestPeekSNI(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	type result struct {
		sni string
		n   int
	}
	resCh := make(chan result, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			resCh <- result{}
			return
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		sni, recorded := peekSNI(conn)
		resCh <- result{sni: sni, n: len(recorded)}
	}()

	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	// The server aborts the handshake after peeking, so the client never gets a
	// ServerHello — bound it with a deadline so this goroutine doesn't hang.
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	tlsClient := tls.Client(c, &tls.Config{ServerName: "my-bucket.s3.amazonaws.com", InsecureSkipVerify: true})
	_ = tlsClient.Handshake() // expected to fail; we only care the ClientHello went out

	res := <-resCh
	if res.sni != "my-bucket.s3.amazonaws.com" {
		t.Errorf("peekSNI sni=%q want my-bucket.s3.amazonaws.com", res.sni)
	}
	if res.n == 0 {
		t.Errorf("peekSNI recorded 0 bytes; expected the ClientHello to be captured for replay")
	}
}
