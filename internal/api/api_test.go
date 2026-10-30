package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
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
	if code, res := call(t, h, "POST", "/api/items/"+id+"/quantity", `{"delta":-1}`); code != 200 || res["quantity"] != float64(0) {
		t.Fatalf("quantity: %d %v", code, res)
	}
	if code, res := call(t, h, "POST", "/api/items/"+id+"/quantity", `{"set":12}`); code != 200 || res["quantity"] != float64(12) {
		t.Fatalf("set quantity: %d %v", code, res)
	}
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
	call(t, h, "POST", "/api/items", `{"name":"Scratch","slots":["C-3"],"tags":["fixing"],"aliases":["velcro","hook and loop"],"notes":"line 1\nline 2","quantity":0}`)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/export", nil))
	exported := rec.Body.String()
	if !strings.HasPrefix(exported, "name,kind,slots,tags,aliases") || !strings.Contains(exported, "velcro; hook and loop") {
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
	if it["notes"] != "line 1\nline 2" || len(it["aliases"].([]any)) != 2 || it["quantity"] != float64(0) {
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

// upload posts files as multipart/form-data, like the browser does.
func upload(t *testing.T, h http.Handler, itemID string, files map[string][]byte) (int, map[string]any) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for name, content := range files {
		fw, err := mw.CreateFormFile("file", name)
		if err != nil {
			t.Fatal(err)
		}
		fw.Write(content)
	}
	mw.Close()
	req := httptest.NewRequest("POST", "/api/items/"+itemID+"/attachments", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestAttachments(t *testing.T) {
	store, err := db.Open(filepath.Join(t.TempDir(), "files.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	// With a password set, only a session or a signed link opens a file.
	if err := store.SetInitialPassword("secret"); err != nil {
		t.Fatal(err)
	}
	h := New(store, false).Handler()
	tool, err := store.CreateItem(db.ItemInput{Kind: "tool", Name: "Multimeter", Brand: "Fluke", Model: "117", Serial: "SN-42"})
	if err != nil {
		t.Fatal(err)
	}
	authed := New(store, true).Handler() // same store, no login needed: for uploads

	pdf := []byte("%PDF-1.4\n% invoice\n")
	code, item := upload(t, authed, tool.ID, map[string][]byte{"Facture Fluke.pdf": pdf, "evil.html": []byte("<html><script>alert(1)</script>")})
	if code != 201 {
		t.Fatalf("upload: %d %v", code, item)
	}
	atts := item["attachments"].([]any)
	if len(atts) != 2 {
		t.Fatalf("attachments: %v", atts)
	}
	byName := map[string]map[string]any{}
	for _, a := range atts {
		m := a.(map[string]any)
		byName[m["filename"].(string)] = m
	}
	invoice, evil := byName["Facture Fluke.pdf"], byName["evil.html"]
	if invoice["content_type"] != "application/pdf" || invoice["label"] != "invoice" {
		t.Errorf("invoice: %v", invoice)
	}
	if evil["content_type"] != "application/octet-stream" {
		t.Errorf("an HTML upload must not keep its type: %v", evil)
	}

	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		return rec
	}
	// Without a session: refused, unless the link is signed.
	if rec := get("/api/attachments/" + invoice["id"].(string)); rec.Code != 401 {
		t.Errorf("unsigned link without session: %d", rec.Code)
	}
	rec := get(invoice["url"].(string))
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), pdf) {
		t.Fatalf("signed link: %d %q", rec.Code, rec.Body.String())
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "inline") {
		t.Errorf("a PDF opens in the viewer: %q", cd)
	}
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "sandbox") {
		t.Errorf("files are sandboxed: %q", csp)
	}
	rec = get(evil["url"].(string))
	if cd := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") || rec.Header().Get("Content-Type") != "application/octet-stream" {
		t.Errorf("HTML is downloaded, never rendered: %q %q", cd, rec.Header().Get("Content-Type"))
	}
	tampered := strings.Replace(invoice["url"].(string), "sig=", "sig=0", 1)
	if rec := get(tampered); rec.Code != 401 {
		t.Errorf("tampered link: %d", rec.Code)
	}

	// Rename, delete and restore.
	if code, res := call(t, authed, "PATCH", "/api/attachments/"+evil["id"].(string), `{"filename":"notes.txt","label":"manual"}`); code != 200 {
		t.Fatalf("rename: %d %v", code, res)
	}
	if code, res := call(t, authed, "DELETE", "/api/attachments/"+evil["id"].(string), ""); code != 200 || len(res["attachments"].([]any)) != 1 {
		t.Fatalf("delete: %d %v", code, res)
	}
	if code, res := call(t, authed, "POST", "/api/attachments/"+evil["id"].(string)+"/restore", "{}"); code != 200 || len(res["attachments"].([]any)) != 2 {
		t.Fatalf("restore: %d %v", code, res)
	}

	// Limits.
	if code, _ := upload(t, authed, tool.ID, map[string][]byte{"empty.pdf": {}}); code != 400 {
		t.Errorf("empty file: %d", code)
	}
	big := bytes.Repeat([]byte("x"), db.MaxAttachmentSize+1)
	if code, _ := upload(t, authed, tool.ID, map[string][]byte{"big.bin": big}); code != 400 {
		t.Errorf("file over the limit: %d", code)
	}
	if code, _ := upload(t, authed, "missing", map[string][]byte{"a.pdf": pdf}); code != 404 {
		t.Errorf("unknown item: %d", code)
	}
	// Tools are not counted.
	if code, _ := call(t, authed, "POST", "/api/items/"+tool.ID+"/quantity", `{"delta":1}`); code != 400 {
		t.Errorf("tool quantity: %d", code)
	}
}
