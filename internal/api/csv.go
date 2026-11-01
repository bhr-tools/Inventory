package api

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ben/inventory/internal/db"
)

// CSV columns. Slots and tags never contain spaces, so they are separated by
// spaces; aliases may, so they are separated by semicolons.
// An empty quantity is 0 for a new item and keeps the count of an existing one.
// kind is part or gear; gear fills type, brand, model, serial, warranty_until
// (YYYY-MM-DD) and status (archived or empty). From older exports, the kind
// tool reads as gear of type tool, and broken and lost as archived. price is
// the purchase price (per unit for a part), like 12.50 or 12,50; empty: none. Attachments are not in the
// file: the server backups hold them.
var csvHeader = []string{"name", "kind", "slots", "tags", "aliases", "quantity", "price", "type", "brand", "model", "serial", "warranty_until", "status", "description", "notes"}

func (a *API) exportCSV(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.Items()
	if err != nil {
		fail(w, r, err)
		return
	}
	var buf bytes.Buffer
	out := csv.NewWriter(&buf)
	_ = out.Write(csvHeader)
	for _, it := range items {
		_ = out.Write([]string{it.Name, it.Kind, strings.Join(it.Slots, " "), strings.Join(it.Tags, " "),
			strings.Join(it.Aliases, "; "), strconv.Itoa(it.Quantity), formatPrice(it.Price), it.Type, it.Brand, it.Model, it.Serial,
			it.WarrantyUntil, it.Status, it.Description, it.Notes})
	}
	out.Flush()
	if err := out.Error(); err != nil {
		fail(w, r, err)
		return
	}
	name := "inventory-" + time.Now().Format("2006-01-02") + ".csv"
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	_, _ = w.Write(buf.Bytes())
}

// importCSV reads a file in the export format (columns may come in any order;
// only "name" is required) and merges it into the inventory.
func (a *API) importCSV(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBody)
	var src io.Reader = r.Body
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		if err := r.ParseMultipartForm(maxUploadBody); err != nil {
			writeError(w, http.StatusBadRequest, "Invalid upload")
			return
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			writeError(w, http.StatusBadRequest, "No file uploaded")
			return
		}
		defer file.Close()
		src = file
	}
	inputs, err := parseCSV(src)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	created, merged, err := a.store.ImportItems(inputs)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"created": created, "merged": merged})
}

func parseCSV(src io.Reader) ([]db.ItemInput, error) {
	in := csv.NewReader(src)
	in.FieldsPerRecord = -1
	header, err := in.Read()
	if errors.Is(err, io.EOF) {
		return nil, errors.New("The file is empty")
	}
	if err != nil {
		return nil, fmt.Errorf("Invalid CSV: %v", err)
	}
	col := map[string]int{}
	for i, h := range header {
		col[strings.ToLower(strings.TrimSpace(strings.TrimPrefix(h, "\ufeff")))] = i
	}
	if _, ok := col["name"]; !ok {
		return nil, errors.New(`The file needs a "name" column`)
	}
	var inputs []db.ItemInput
	for line := 2; ; line++ {
		rec, err := in.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("Invalid CSV at line %d: %v", line, err)
		}
		field := func(name string) string {
			if i, ok := col[name]; ok && i < len(rec) {
				return strings.TrimSpace(rec[i])
			}
			return ""
		}
		if field("name") == "" {
			continue
		}
		var quantity *int
		if q := field("quantity"); q != "" {
			n, err := strconv.Atoi(q)
			if err != nil {
				return nil, fmt.Errorf("Line %d: the quantity %q is not a whole number", line, q)
			}
			quantity = &n
		}
		var price *int
		if p := field("price"); p != "" {
			cents, err := parsePrice(p)
			if err != nil {
				return nil, fmt.Errorf("Line %d: the price %q is not an amount like 12.50", line, p)
			}
			price = &cents
		}
		inputs = append(inputs, db.ItemInput{
			Kind:          field("kind"),
			Price:         price,
			Type:          field("type"),
			Brand:         field("brand"),
			Model:         field("model"),
			Serial:        field("serial"),
			WarrantyUntil: field("warranty_until"),
			Status:        field("status"),
			Name:          field("name"),
			Slots:         strings.Fields(field("slots")),
			Tags:          strings.Fields(field("tags")),
			Aliases:       strings.Split(field("aliases"), ";"),
			Quantity:      quantity,
			Description:   field("description"),
			Notes:         field("notes"),
		})
	}
	return inputs, nil
}

// formatPrice writes cents as "12.50", or nothing when no price is set.
func formatPrice(cents int) string {
	if cents == 0 {
		return ""
	}
	return fmt.Sprintf("%d.%02d", cents/100, cents%100)
}

// parsePrice reads "12.50", "12,5", "12" or "12.50 €" as cents.
func parsePrice(text string) (int, error) {
	text = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(text), "€"))
	text = strings.ReplaceAll(strings.ReplaceAll(text, " ", ""), ",", ".")
	units, frac, _ := strings.Cut(text, ".")
	if len(frac) > 2 {
		return 0, errors.New("more than 2 decimals")
	}
	frac = (frac + "00")[:2]
	whole, err := strconv.Atoi(units)
	if err != nil || whole < 0 {
		return 0, errors.New("not an amount")
	}
	cents, err := strconv.Atoi(frac)
	if err != nil || strings.HasPrefix(frac, "-") {
		return 0, errors.New("not an amount")
	}
	return whole*100 + cents, nil
}
