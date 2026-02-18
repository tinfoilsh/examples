package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
)

const (
	enclaveURLHeader   = "X-Tinfoil-Enclave-Url"
	sessionIDHeader    = "X-Session-Id"
	responseNonceHdr   = "Ehbp-Response-Nonce"
	encapsulatedKeyHdr = "Ehbp-Encapsulated-Key"

	allowHeaders  = "Accept, Authorization, Content-Type, " + encapsulatedKeyHdr + ", " + enclaveURLHeader + ", " + sessionIDHeader
	exposeHeaders = responseNonceHdr

)

// ---------------------------------------------------------------------------
// Session buffer for recovery
// ---------------------------------------------------------------------------

// session holds a buffered copy of an encrypted streaming response.
type session struct {
	mu         sync.Mutex
	cond       *sync.Cond
	statusCode int
	headers    http.Header
	buf        bytes.Buffer
	done       bool
}

type sessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*session
}

var store = &sessionStore{sessions: make(map[string]*session)}

func (s *sessionStore) create(id string) *session {
	sess := &session{
		headers: make(http.Header),
	}
	sess.cond = sync.NewCond(&sess.mu)
	s.mu.Lock()
	s.sessions[id] = sess
	s.mu.Unlock()
	return sess
}

func (s *sessionStore) get(id string) *session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessions[id]
}

func (s *sessionStore) remove(id string) {
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
}

// resilientTeeWriter writes to both primary and fallible. If fallible
// errors (e.g. client disconnected), it is abandoned and writes continue
// to primary only. Primary errors are fatal.
type resilientTeeWriter struct {
	primary  io.Writer
	fallible io.Writer
}

func (rw *resilientTeeWriter) Write(p []byte) (int, error) {
	if rw.fallible != nil {
		if _, err := rw.fallible.Write(p); err != nil {
			log.Printf("client disconnected, continuing to buffer session")
			rw.fallible = nil
		}
	}
	return rw.primary.Write(p)
}

// sessionWriter appends bytes to the session buffer under a lock.
type sessionWriter struct{ sess *session }

func (sw *sessionWriter) Write(p []byte) (int, error) {
	sw.sess.mu.Lock()
	n, err := sw.sess.buf.Write(p)
	sw.sess.cond.Broadcast()
	sw.sess.mu.Unlock()
	return n, err
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

func main() {
	http.HandleFunc("/v1/chat/completions", proxyHandler)
	http.HandleFunc("/v1/responses", proxyHandler)
	http.HandleFunc("/attestation", attestationHandler)
	http.HandleFunc("/recovery/", recoveryRouter)

	log.Println("proxy listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

// ---------------------------------------------------------------------------
// Proxy handler — forwards requests to the enclave, tee-buffers for recovery
// ---------------------------------------------------------------------------

func proxyHandler(w http.ResponseWriter, r *http.Request) {
	setCORS(w, "POST, OPTIONS", allowHeaders, exposeHeaders)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	apiKey := os.Getenv("TINFOIL_API_KEY")
	if apiKey == "" {
		http.Error(w, "TINFOIL_API_KEY not set", http.StatusInternalServerError)
		return
	}

	upstreamBase := r.Header.Get(enclaveURLHeader)
	if upstreamBase == "" {
		http.Error(w, enclaveURLHeader+" header required", http.StatusBadRequest)
		return
	}

	// When recovery is active, use a background context so the upstream
	// connection survives a client disconnect (tab close).
	sessionID := r.Header.Get(sessionIDHeader)
	ctx := r.Context()
	if sessionID != "" {
		ctx = context.Background()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstreamBase+r.URL.Path, r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	if accept := r.Header.Get("Accept"); accept != "" {
		req.Header.Set("Accept", accept)
	}
	copyHeader(req.Header, r.Header, encapsulatedKeyHdr)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	copyHeader(w.Header(), resp.Header, responseNonceHdr)
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if te := resp.Header.Get("Transfer-Encoding"); te != "" {
		w.Header().Set("Transfer-Encoding", te)
		w.Header().Del("Content-Length")
	}

	// If the client sent a session ID, tee-write into a recovery buffer
	var sess *session
	if sessionID != "" {
		log.Printf("[session %s] created, buffering %s", sessionID, r.URL.Path)
		sess = store.create(sessionID)
		sess.mu.Lock()
		sess.statusCode = resp.StatusCode
		copyHeader(sess.headers, resp.Header, responseNonceHdr)
		if ct := resp.Header.Get("Content-Type"); ct != "" {
			sess.headers.Set("Content-Type", ct)
		}
		sess.mu.Unlock()
	}

	w.WriteHeader(resp.StatusCode)

	var dst io.Writer = w
	if flusher, ok := w.(http.Flusher); ok {
		dst = &flushWriter{ResponseWriter: w, Flusher: flusher}
	}
	if sess != nil {
		dst = &resilientTeeWriter{
			primary:  &sessionWriter{sess: sess},
			fallible: dst,
		}
	}

	if _, copyErr := io.Copy(dst, resp.Body); copyErr != nil {
		log.Printf("stream copy: %v", copyErr)
	}

	if sess != nil {
		sess.mu.Lock()
		log.Printf("[session %s] stream complete, %d bytes buffered", sessionID, sess.buf.Len())
		sess.done = true
		sess.cond.Broadcast()
		sess.mu.Unlock()
	}
}

// ---------------------------------------------------------------------------
// Recovery endpoints
// ---------------------------------------------------------------------------

// recoveryRouter dispatches /recovery/{id} and /recovery/{id}/status.
func recoveryRouter(w http.ResponseWriter, r *http.Request) {
	setCORS(w, "GET, DELETE, OPTIONS", "Content-Type", responseNonceHdr)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/recovery/")
	if path == "" {
		http.Error(w, "session ID required", http.StatusBadRequest)
		return
	}

	sessionID := path
	isStatus := false
	if strings.HasSuffix(path, "/status") {
		sessionID = strings.TrimSuffix(path, "/status")
		isStatus = true
	}

	switch r.Method {
	case http.MethodGet:
		if isStatus {
			recoveryStatus(w, sessionID)
		} else {
			recoveryFetch(w, sessionID)
		}
	case http.MethodDelete:
		log.Printf("[session %s] deleted", sessionID)
		store.remove(sessionID)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func recoveryStatus(w http.ResponseWriter, id string) {
	sess := store.get(id)
	if sess == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"status": "not_found"})
		return
	}

	sess.mu.Lock()
	status := "in_progress"
	if sess.done {
		status = "complete"
	}
	size := sess.buf.Len()
	sess.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": status,
		"bytes":  size,
	})
}

func recoveryFetch(w http.ResponseWriter, id string) {
	sess := store.get(id)
	if sess == nil {
		log.Printf("[session %s] recovery requested, not found", id)
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	log.Printf("[session %s] recovery requested, streaming buffered response", id)
	flusher, canFlush := w.(http.Flusher)

	// Write response headers (wait until we have them).
	sess.mu.Lock()
	for sess.statusCode == 0 && !sess.done {
		sess.cond.Wait()
	}
	for key, vals := range sess.headers {
		for _, v := range vals {
			w.Header().Set(key, v)
		}
	}
	w.WriteHeader(sess.statusCode)
	sess.mu.Unlock()

	// Stream buffered bytes, waiting for new data as it arrives.
	offset := 0
	for {
		sess.mu.Lock()
		for sess.buf.Len() == offset && !sess.done {
			sess.cond.Wait()
		}
		data := sess.buf.Bytes()[offset:]
		done := sess.done
		sess.mu.Unlock()

		if len(data) > 0 {
			if _, err := w.Write(data); err != nil {
				log.Printf("[session %s] recovery client disconnected at %d bytes", id, offset)
				return
			}
			offset += len(data)
			if canFlush {
				flusher.Flush()
			}
		}

		if done {
			log.Printf("[session %s] recovery complete, sent %d bytes", id, offset)
			return
		}
	}
}

// ---------------------------------------------------------------------------
// Attestation proxy
// ---------------------------------------------------------------------------

func attestationHandler(w http.ResponseWriter, r *http.Request) {
	setCORS(w, "GET, OPTIONS", "Content-Type", "")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	resp, err := http.Get("https://atc.tinfoil.sh/attestation")
	if err != nil {
		http.Error(w, "failed to fetch attestation bundle", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type flushWriter struct {
	http.ResponseWriter
	http.Flusher
}

func (fw *flushWriter) Write(p []byte) (int, error) {
	n, err := fw.ResponseWriter.Write(p)
	fw.Flush()
	return n, err
}

func copyHeader(dst, src http.Header, key string) {
	if v := src.Get(key); v != "" {
		dst.Set(key, v)
	}
}

func setCORS(w http.ResponseWriter, methods, allow, expose string) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", methods)
	w.Header().Set("Access-Control-Allow-Headers", allow)
	if expose != "" {
		w.Header().Set("Access-Control-Expose-Headers", expose)
	}
}
