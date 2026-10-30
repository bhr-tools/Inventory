package main

import (
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ben/inventory/internal/db"
)

func TestHandlerRoutes(t *testing.T) {
	store, err := db.Open(filepath.Join(t.TempDir(), "main.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	h := newHandler(store, true)

	tests := []struct {
		path, wantBody string
		wantStatus     int
	}{
		{"/", "<title>Inventory</title>", 200},
		{"/js/app.js", "class App", 200},
		{"/css/style.css", "rose-pine.css", 200},
		{"/healthz", "ok", 200},
		{"/api/inventory", `"items":[]`, 200},
		{"/embed.go", "", 404}, // source files are not served
		{"/api/unknown", "Unknown API endpoint", 404},
	}
	for _, tt := range tests {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", tt.path, nil))
		if rec.Code != tt.wantStatus || !strings.Contains(rec.Body.String(), tt.wantBody) {
			t.Errorf("GET %s = %d %q, want %d containing %q", tt.path, rec.Code, rec.Body.String()[:min(80, rec.Body.Len())], tt.wantStatus, tt.wantBody)
		}
	}
}
