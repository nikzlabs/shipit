package main

import (
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
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
		{"API.GitHub.com", ".github.com", true},
		{"api.github.com.", ".github.com", true},
		{"evilgithub.com", ".github.com", false},
		{"github.com.evil.com", ".github.com", false},
		{"github.com", "github.com", true},
		{"api.github.com", "github.com", false},
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
	if r := parseIdentityRules(""); r != nil {
		t.Errorf("empty → %v want nil", r)
	}
	if r := parseIdentityRules("   "); r != nil {
		t.Errorf("whitespace → %v want nil", r)
	}
	if r := parseIdentityRules("{not json"); r != nil {
		t.Errorf("malformed → %v want nil", r)
	}
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
		{"s3.amazonaws.com", "s3.amazonaws.com", "", true},
		{"MY-BUCKET.S3.amazonaws.com", "s3.amazonaws.com", "my-bucket", true},
		{"a.b.s3.amazonaws.com", "s3.amazonaws.com", "a.b", true},
		{"github.com", "s3.amazonaws.com", "", false},
		{"evil-s3.amazonaws.com", "s3.amazonaws.com", "", false},
	}
	for _, c := range cases {
		gotT, gotOK := tenantPrefix(c.sni, c.base)
		if gotT != c.wantTenant || gotOK != c.wantOK {
			t.Errorf("tenantPrefix(%q,%q)=(%q,%v) want (%q,%v)", c.sni, c.base, gotT, gotOK, c.wantTenant, c.wantOK)
		}
	}
}

func TestValidateIdentity(t *testing.T) {
	identityRules = nil
	for _, sni := range []string{"my-bucket.s3.amazonaws.com", "github.com", "s3.amazonaws.com"} {
		if !validateIdentity(sni) {
			t.Errorf("with no rules, validateIdentity(%q)=false want true", sni)
		}
	}

	identityRules = parseIdentityRules(`[{"host":".s3.amazonaws.com","identities":["my-bucket"]}]`)
	cases := []struct {
		sni  string
		want bool
	}{
		{"my-bucket.s3.amazonaws.com", true},
		{"MY-BUCKET.s3.amazonaws.com", true},
		{"attacker.s3.amazonaws.com", false},
		{"s3.amazonaws.com", false},
		{"github.com", true},
		{"my-bucket.s3.us-east-1.amazonaws.com", true},
	}
	for _, c := range cases {
		if got := validateIdentity(c.sni); got != c.want {
			t.Errorf("validateIdentity(%q)=%v want %v", c.sni, got, c.want)
		}
	}

	identityRules = parseIdentityRules(`[{"host":".s3.amazonaws.com","identities":["my-bucket",""]}]`)
	if !validateIdentity("s3.amazonaws.com") {
		t.Errorf("apex with \"\" opt-in should be permitted")
	}
	if validateIdentity("attacker.s3.amazonaws.com") {
		t.Errorf("apex opt-in must not widen tenant scoping")
	}

	identityRules = nil
}

func TestMatchIdentityRuleMostSpecific(t *testing.T) {
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
	if !validateIdentity("wide.amazonaws.com") {
		t.Errorf("broad rule should govern hosts the specific rule does not cover")
	}
	if validateIdentity("wide.ec2.amazonaws.com") {
		t.Errorf("tenant prefix %q != %q; should not match", "wide.ec2", "wide")
	}
}

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
	// The intentional handshake abort needs a deadline.
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	tlsClient := tls.Client(c, &tls.Config{ServerName: "my-bucket.s3.amazonaws.com", InsecureSkipVerify: true})
	_ = tlsClient.Handshake()

	res := <-resCh
	if res.sni != "my-bucket.s3.amazonaws.com" {
		t.Errorf("peekSNI sni=%q want my-bucket.s3.amazonaws.com", res.sni)
	}
	if res.n == 0 {
		t.Errorf("peekSNI recorded 0 bytes; expected the ClientHello to be captured for replay")
	}
}

func TestFetchDecisionSendsToken(t *testing.T) {
	var gotToken, gotSession, gotHost string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get(decisionTokenHeader)
		gotSession = r.URL.Query().Get("session")
		gotHost = r.URL.Query().Get("host")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"allow":true}`))
	}))
	defer srv.Close()

	prevURL, prevToken, prevSession := decisionURL, decisionToken, sessionID
	defer func() { decisionURL, decisionToken, sessionID = prevURL, prevToken, prevSession }()
	decisionURL, decisionToken, sessionID = srv.URL, "tok-123", "sess-1"

	if !fetchDecision("example.com") {
		t.Fatal("expected the orchestrator's allow to be honoured")
	}
	if gotToken != "tok-123" {
		t.Errorf("token header = %q, want %q", gotToken, "tok-123")
	}
	if gotSession != "sess-1" || gotHost != "example.com" {
		t.Errorf("query = session %q host %q; want sess-1 / example.com", gotSession, gotHost)
	}
}

func TestFetchDecisionOmitsAbsentToken(t *testing.T) {
	present := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, present = r.Header[decisionTokenHeader]
		_, _ = w.Write([]byte(`{"allow":false}`))
	}))
	defer srv.Close()

	prevURL, prevToken := decisionURL, decisionToken
	defer func() { decisionURL, decisionToken = prevURL, prevToken }()
	decisionURL, decisionToken = srv.URL, ""

	fetchDecision("example.com")
	if present {
		t.Error("no token configured, but the header was sent")
	}
}
