package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ben/inventory/internal/db"
)

func newTestAPI(t *testing.T) http.Handler {
	t.Helper()
	store, err := db.Open(filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return New(store, true).Handler()
}

func call(t *testing.T, h http.Handler, method, path, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestItemLifecycle(t *testing.T) {
	h := newTestAPI(t)
	code, item := call(t, h, "POST", "/api/items", `{"name":"ESP32","slots":["a1"],"tags":["#MCU"]}`)
	if code != 201 || item["id"] == "" {
		t.Fatalf("create: %d %v", code, item)
	}
	id := item["id"].(string)

	code, dup := call(t, h, "POST", "/api/items", `{"name":"esp32"}`)
	if code != 409 || dup["existing_id"] != id {
		t.Fatalf("duplicate: %d %v", code, dup)
	}
	if code, res := call(t, h, "POST", "/api/items", `{"name":"X","slots":["nope"]}`); code != 400 || !strings.Contains(res["error"].(string), "slot") {
		t.Fatalf("bad slot: %d %v", code, res)
	}

	call(t, h, "POST", "/api/items", `{"name":"Velcro","slots":["B-2"]}`)
	if code, inv := call(t, h, "POST", "/api/slots/swap", `{"a":"A-1","b":"B-2"}`); code != 200 || len(inv["items"].([]any)) != 2 {
		t.Fatalf("swap: %d %v", code, inv)
	}
	_, got := call(t, h, "GET", "/api/items/"+id, "")
	if s := got["slots"].([]any); len(s) != 1 || s[0] != "B-2" {
		t.Fatalf("after swap: %v", got)
	}

	code, del := call(t, h, "POST", "/api/items/delete", `{"ids":["`+id+`"]}`)
	if code != 200 || len(del["items"].([]any)) != 1 {
		t.Fatalf("delete: %d %v", code, del)
	}
	removed, _ := json.Marshal(del["items"])
	if code, _ := call(t, h, "POST", "/api/items/restore", `{"items":`+string(removed)+`}`); code != 200 {
		t.Fatalf("restore: %d", code)
	}
	if code, _ := call(t, h, "GET", "/api/items/"+id, ""); code != 200 {
		t.Fatalf("restored item: %d", code)
	}
}

func TestCSVRoundTrip(t *testing.T) {
	h := newTestAPI(t)
	call(t, h, "POST", "/api/items", `{"name":"Scratch","slots":["C-3"],"tags":["fixing"],"aliases":["velcro","hook and loop"],"notes":"line 1\nline 2"}`)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/export", nil))
	exported := rec.Body.String()
	if !strings.HasPrefix(exported, "name,slots,tags,aliases") || !strings.Contains(exported, "velcro; hook and loop") {
		t.Fatalf("export: %q", exported)
	}

	other := newTestAPI(t)
	req := httptest.NewRequest("POST", "/api/import", bytes.NewBufferString(exported))
	req.Header.Set("Content-Type", "text/csv")
	rec = httptest.NewRecorder()
	other.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"created":1`) {
		t.Fatalf("import: %d %s", rec.Code, rec.Body.String())
	}
	_, inv := call(t, other, "GET", "/api/inventory", "")
	it := inv["items"].([]any)[0].(map[string]any)
	if it["notes"] != "line 1\nline 2" || len(it["aliases"].([]any)) != 2 {
		t.Fatalf("imported %v", it)
	}
}

func TestCrossSiteRefused(t *testing.T) {
	h := newTestAPI(t)
	req := httptest.NewRequest("POST", "/api/items", strings.NewReader(`{"name":"X"}`))
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("got %d", rec.Code)
	}
}
