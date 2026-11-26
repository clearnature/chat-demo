// chat-reader: server-side web_fetch for chat-demo.
// Ported from clearnature/DeepSeek-Reasonix dev/wails internal/tool/builtin/webfetch.go
// (SSRF-guarded dialer + readable text extraction, 15s / 1 MiB / <=3 redirects).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"golang.org/x/net/html"
)

const (
	listenAddr = "127.0.0.1:8889"
	timeout    = 15 * time.Second
	maxBody    = 1 << 20 // 1 MiB
	maxOut     = 16000   // chars returned to the model
)

var client = &http.Client{
	Timeout: timeout,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return fmt.Errorf("too many redirects")
		}
		return nil
	},
	Transport: &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			host = strings.Trim(host, "[]")
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			for _, ip := range ips {
				if blockedIP(ip.IP) {
					return nil, fmt.Errorf("refusing to fetch internal address %s (%s)", host, ip.IP)
				}
			}
			return (&net.Dialer{Timeout: timeout}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		},
	},
}

// blockedIP: private, loopback, link-local, multicast, unspecified, CGNAT,
// benchmarking, reserved and IPv4-mapped ranges. Cloud metadata 169.254.169.254
// is link-local and therefore covered.
func blockedIP(ip net.IP) bool {
	if ip == nil || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}
	for _, cidr := range []string{
		"100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15",
		"198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
		"fc00::/7", "ff00::/8", "2001:db8::/32",
	} {
		_, n, _ := net.ParseCIDR(cidr)
		if n != nil && n.Contains(ip) {
			return true
		}
	}
	return false
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	mux.HandleFunc("/", handleFetch)
	srv := &http.Server{Addr: listenAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		panic(err)
	}
}

func handleFetch(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		writeJSON(w, 400, map[string]any{"error": "invalid url: must be absolute http(s)"})
		return
	}
	if u.User != nil {
		writeJSON(w, 400, map[string]any{"error": "url credentials are not allowed"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	req.Header.Set("User-Agent", "chat-demo-reader/1.0 (+https://aecci.net)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5")
	resp, err := client.Do(req)
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		writeJSON(w, 502, map[string]any{"error": fmt.Sprintf("upstream status %d", resp.StatusCode)})
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		writeJSON(w, 502, map[string]any{"error": err.Error()})
		return
	}
	truncated := len(body) > maxBody
	if truncated {
		body = body[:maxBody]
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	out := map[string]any{"url": resp.Request.URL.String(), "truncated": truncated}
	if strings.Contains(ct, "html") || strings.Contains(ct, "xhtml") {
		title, text := extractHTML(body)
		out["title"] = title
		out["text"] = clipText(text, maxOut)
	} else {
		out["title"] = ""
		out["text"] = clipText(string(body), maxOut)
	}
	if int64(len(out["text"].(string))) >= maxOut {
		out["truncated"] = true
	}
	writeJSON(w, 200, out)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func clipText(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

var blockTags = map[string]bool{
	"p": true, "div": true, "section": true, "article": true, "main": true, "header": true,
	"footer": true, "aside": true, "nav": true, "br": true, "li": true, "ul": true, "ol": true,
	"h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true, "tr": true,
	"table": true, "pre": true, "blockquote": true, "hr": true, "dd": true, "dt": true,
}

func extractHTML(body []byte) (string, string) {
	doc, err := html.Parse(strings.NewReader(string(body)))
	if err != nil {
		return "", collapse(string(body))
	}
	var title string
	var b strings.Builder
	var walk func(*html.Node, bool)
	walk = func(n *html.Node, skip bool) {
		if n.Type == html.ElementNode {
			name := strings.ToLower(n.Data)
			if name == "script" || name == "style" || name == "noscript" || name == "template" {
				return
			}
			if name == "title" && n.FirstChild != nil {
				title = strings.TrimSpace(n.FirstChild.Data)
			}
			if blockTags[name] {
				b.WriteString("\n")
			}
		}
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, skip)
		}
		if n.Type == html.ElementNode && blockTags[strings.ToLower(n.Data)] {
			b.WriteString("\n")
		}
	}
	walk(doc, false)
	return collapse(title), collapse(b.String())
}

func collapse(s string) string {
	var b strings.Builder
	lastSpace := true
	for _, r := range s {
		if r == '\n' || r == '\r' || r == '\t' {
			r = '\n'
		}
		if unicode.IsSpace(r) {
			if r == '\n' {
				if !lastSpace {
					b.WriteRune('\n')
					lastSpace = true
				}
			} else if !lastSpace {
				b.WriteRune(' ')
				lastSpace = true
			}
			continue
		}
		b.WriteRune(r)
		lastSpace = false
	}
	return strings.TrimSpace(b.String())
}
