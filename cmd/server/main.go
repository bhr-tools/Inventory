// Command server runs Inventory: the JSON API and the embedded web app.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ben/inventory/internal/api"
	"github.com/ben/inventory/internal/db"
	"github.com/ben/inventory/web"
)

// Each flag defaults to its environment variable, so the binary is configured
// with flags (NixOS module) or environment (container) alike.
func main() {
	host := flag.String("host", envOr("HOST", "127.0.0.1"), "listen address (env HOST)")
	port := flag.Int("port", envInt("PORT", 8080), "listen port (env PORT)")
	dataDir := flag.String("data-dir", envOr("DATA_DIR", "./data"), "directory of the database (env DATA_DIR)")
	dbPath := flag.String("db", os.Getenv("DB_PATH"), "database file, overrides -data-dir (env DB_PATH)")
	noAuth := flag.Bool("no-auth", envBool("NO_AUTH"), "disable the master password (env NO_AUTH=true)")
	flag.Parse()

	if *port < 1 || *port > 65535 {
		log.Fatalf("invalid port %d", *port)
	}
	path := *dbPath
	if path == "" {
		path = filepath.Join(*dataDir, "inventory.db")
	}

	store, err := db.Open(path)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer store.Close()

	go purgeAttachments(store)

	addr := net.JoinHostPort(*host, strconv.Itoa(*port))
	server := &http.Server{
		Addr:              addr,
		Handler:           newHandler(store, *noAuth),
		ReadHeaderTimeout: 10 * time.Second,
		// No server-wide read/write timeouts: deadlines() sets them per request,
		// and file transfers extend theirs.
		IdleTimeout: 120 * time.Second,
	}

	go func() {
		log.Printf("Inventory listening on http://%s (database %s)", addr, path)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Println("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

// newHandler routes the API, the health check and the web app.
func newHandler(store *db.Store, noAuth bool) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/api/", api.New(store, noAuth).Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := store.Ping(); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		fmt.Fprintln(w, "ok")
	})
	mux.Handle("/", noCache(http.FileServerFS(web.Files)))
	return deadlines(securityHeaders(mux))
}

// requestTimeout bounds reading the request and writing the answer. Handlers
// moving files extend it with http.ResponseController.
const requestTimeout = 60 * time.Second

func deadlines(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		_ = rc.SetReadDeadline(time.Now().Add(requestTimeout))
		_ = rc.SetWriteDeadline(time.Now().Add(requestTimeout))
		next.ServeHTTP(w, r)
	})
}

// purgeAttachments removes, once a day, the files deleted (or whose item was
// deleted) more than db.AttachmentRetention ago.
func purgeAttachments(store *db.Store) {
	for {
		if n, err := store.PurgeAttachments(time.Now().Add(-db.AttachmentRetention)); err != nil {
			log.Printf("purge attachments: %v", err)
		} else if n > 0 {
			log.Printf("purged %d attachments", n)
		}
		time.Sleep(24 * time.Hour)
	}
}

// noCache makes browsers revalidate the web app on every load, so an upgrade
// never mixes old and new JavaScript modules.
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		next.ServeHTTP(w, r)
	})
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		log.Fatalf("invalid %s=%q: not a number", key, v)
	}
	return n
}

func envBool(key string) bool {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return false
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		log.Fatalf("invalid %s=%q: expected true or false", key, v)
	}
	return b
}
