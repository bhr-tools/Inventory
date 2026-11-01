package db

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// A database created by the first release (stock levels) keeps its items and
// turns "out" into a count of 0.
func TestMigratesStockToQuantity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	old, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		migrations[0],
		`INSERT INTO items (id, name, name_key, stock, created_at, updated_at) VALUES
			('a', 'Bolts', 'bolts', 'out', '', ''),
			('b', 'Nuts', 'nuts', 'low', '', ''),
			('c', 'Glue', 'glue', '', '', '')`,
		"PRAGMA user_version = 1",
	} {
		if _, err := old.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	old.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	items, err := s.Items()
	if err != nil {
		t.Fatal(err)
	}
	// "out" was the only level meaning "buy more": it is the only one on the
	// shopping list. Every item now has a count.
	got := map[string]string{}
	for _, it := range items {
		got[it.Name] = fmt.Sprintf("%d %v", it.Quantity, it.ToBuy)
	}
	want := map[string]string{"Bolts": "0 true", "Nuts": "0 false", "Glue": "0 false"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("after migration: %v, want %v", got, want)
	}
}

// Migrations 5 and 6: broken and lost tools are archived, and every tool
// becomes gear of type tool.
func TestMigratesToolsToArchivedGear(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v4.db")
	old, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range append(append([]string{}, migrations[:4]...),
		`INSERT INTO items (id, name, name_key, kind, status, quantity, created_at, updated_at) VALUES
			('a', 'Saw', 'saw', 'tool', 'broken', 0, '', ''),
			('b', 'Pliers', 'pliers', 'tool', 'lost', 0, '', ''),
			('c', 'Drill', 'drill', 'tool', '', 0, '', '')`,
		"PRAGMA user_version = 4") {
		if _, err := old.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	old.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	items, err := s.Items()
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, it := range items {
		got[it.Name] = it.Kind + " " + it.Type + " " + it.Status
	}
	want := map[string]string{"Saw": "gear tool archived", "Pliers": "gear tool archived", "Drill": "gear tool "}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("after migration: %v, want %v", got, want)
	}
}

func mustCreate(t *testing.T, s *Store, in ItemInput) Item {
	t.Helper()
	it, err := s.CreateItem(in)
	if err != nil {
		t.Fatalf("create %q: %v", in.Name, err)
	}
	return it
}

func TestParseSlot(t *testing.T) {
	ok := map[string]string{
		"A-12": "A-12", "a12": "A-12", " a - 12 ": "A-12", "a 12": "A-12",
		"B2-3": "B2-3", "AB7": "AB-7", "C-007": "C-7",
	}
	for in, want := range ok {
		got, err := ParseSlot(in)
		if err != nil || got.String() != want {
			t.Errorf("ParseSlot(%q) = %v, %v; want %s", in, got, err, want)
		}
	}
	for _, in := range []string{"", "12", "A", "A-0", "A-10000", "-12", "A--12", "ABCDEFGHI-1", "B23x"} {
		if _, err := ParseSlot(in); err == nil {
			t.Errorf("ParseSlot(%q) accepted", in)
		}
	}
}

func TestNormalizeTag(t *testing.T) {
	ok := map[string]string{
		"#Electronic": "electronic", " Electronic / MCU ": "electronic/mcu",
		"hook and loop": "hook-and-loop", "a//b/": "a/b",
	}
	for in, want := range ok {
		if got, err := NormalizeTag(in); err != nil || got != want {
			t.Errorf("NormalizeTag(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "#", "a,b", "a@b"} {
		if _, err := NormalizeTag(in); err == nil {
			t.Errorf("NormalizeTag(%q) accepted", in)
		}
	}
}

func TestCreateNormalizesAndRefusesDuplicates(t *testing.T) {
	s := openTest(t)
	it := mustCreate(t, s, ItemInput{
		Name:    "  Résistance   10k ",
		Slots:   []string{"b3", "A-12", "a12"},
		Tags:    []string{"#Electronic/Passive", "electronic/passive"},
		Aliases: []string{"resistor", "Resistor", "résistance 10K"},
	})
	want := Item{Name: "Résistance 10k", Slots: []string{"A-12", "B-3"}, Tags: []string{"electronic/passive"}, Aliases: []string{"resistor"}}
	if it.Name != want.Name || !reflect.DeepEqual(it.Slots, want.Slots) || !reflect.DeepEqual(it.Tags, want.Tags) || !reflect.DeepEqual(it.Aliases, want.Aliases) {
		t.Fatalf("got %+v", it)
	}

	_, err := s.CreateItem(ItemInput{Name: "RESISTANCE 10K"})
	var dup *DuplicateError
	if !errors.As(err, &dup) || dup.ExistingID != it.ID {
		t.Fatalf("duplicate: got %v", err)
	}

	other := mustCreate(t, s, ItemInput{Name: "Capacitor"})
	if _, err := s.UpdateItem(other.ID, ItemInput{Name: "resistance 10k"}); !errors.As(err, &dup) {
		t.Fatalf("rename onto existing name: got %v", err)
	}
	if _, err := s.UpdateItem(it.ID, ItemInput{Name: "Résistance 10K", Quantity: intPtr(3)}); err != nil {
		t.Fatalf("renaming an item to itself: %v", err)
	}
	if _, err := s.CreateItem(ItemInput{Name: "X", Quantity: intPtr(-1)}); err == nil {
		t.Fatal("negative quantity accepted")
	}
}

func TestItemsAreOrderedBySlot(t *testing.T) {
	s := openTest(t)
	mustCreate(t, s, ItemInput{Name: "Loose"})
	mustCreate(t, s, ItemInput{Name: "B one", Slots: []string{"B-1"}})
	mustCreate(t, s, ItemInput{Name: "A ten", Slots: []string{"A-10"}})
	mustCreate(t, s, ItemInput{Name: "A two", Slots: []string{"A-2"}})
	items, err := s.Items()
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, it := range items {
		names = append(names, it.Name)
	}
	if want := []string{"A two", "A ten", "B one", "Loose"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("order = %v, want %v", names, want)
	}
}

func TestMoveAndSwap(t *testing.T) {
	s := openTest(t)
	a := mustCreate(t, s, ItemInput{Name: "In A", Slots: []string{"A-1", "C-1"}})
	b := mustCreate(t, s, ItemInput{Name: "In B", Slots: []string{"B-1"}})
	both := mustCreate(t, s, ItemInput{Name: "In both", Slots: []string{"A-1", "B-1"}})

	if err := s.SwapSlots("a1", "B-1"); err != nil {
		t.Fatal(err)
	}
	slots := func(id string) []string {
		it, err := s.Item(id)
		if err != nil {
			t.Fatal(err)
		}
		return it.Slots
	}
	if got := slots(a.ID); !reflect.DeepEqual(got, []string{"B-1", "C-1"}) {
		t.Errorf("A after swap: %v", got)
	}
	if got := slots(b.ID); !reflect.DeepEqual(got, []string{"A-1"}) {
		t.Errorf("B after swap: %v", got)
	}
	if got := slots(both.ID); !reflect.DeepEqual(got, []string{"A-1", "B-1"}) {
		t.Errorf("both after swap: %v", got)
	}

	if err := s.MoveItems([]string{a.ID, b.ID}, "D-4"); err != nil {
		t.Fatal(err)
	}
	if got := slots(a.ID); !reflect.DeepEqual(got, []string{"D-4"}) {
		t.Errorf("A after move: %v", got)
	}
	if err := s.MoveItems([]string{"missing"}, "D-4"); !errors.Is(err, ErrNotFound) {
		t.Errorf("move missing: %v", err)
	}
}

func TestRenameAndDeleteTags(t *testing.T) {
	s := openTest(t)
	x := mustCreate(t, s, ItemInput{Name: "X", Tags: []string{"electronic", "electronic/mcu", "electronics-old"}})
	y := mustCreate(t, s, ItemInput{Name: "Y", Tags: []string{"elec"}})
	if err := s.RenameTag("electronic", "elec"); err != nil {
		t.Fatal(err)
	}
	gotX, _ := s.Item(x.ID)
	if want := []string{"elec", "elec/mcu", "electronics-old"}; !reflect.DeepEqual(gotX.Tags, want) {
		t.Errorf("tags after rename: %v, want %v", gotX.Tags, want)
	}
	if err := s.RenameTag("elec", "elec/sub"); err == nil {
		t.Error("moving a tag under itself was accepted")
	}
	if err := s.TagItems([]string{x.ID, y.ID}, []string{"#Bench"}, []string{"elec"}); err != nil {
		t.Fatal(err)
	}
	gotY, _ := s.Item(y.ID)
	if want := []string{"bench"}; !reflect.DeepEqual(gotY.Tags, want) {
		t.Errorf("tags after bulk tag: %v", gotY.Tags)
	}
	if err := s.DeleteTag("bench"); err != nil {
		t.Fatal(err)
	}
	gotX, _ = s.Item(x.ID)
	if want := []string{"elec/mcu", "electronics-old"}; !reflect.DeepEqual(gotX.Tags, want) {
		t.Errorf("tags after delete: %v", gotX.Tags)
	}
}

func TestDeleteAndRestore(t *testing.T) {
	s := openTest(t)
	it := mustCreate(t, s, ItemInput{Name: "Velcro", Slots: []string{"C-3"}, Tags: []string{"fixing"}, Aliases: []string{"hook and loop"}})
	removed, err := s.DeleteItems([]string{it.ID, "missing"})
	if err != nil || len(removed) != 1 {
		t.Fatalf("delete: %v, %v", removed, err)
	}
	if _, err := s.Item(it.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("still there: %v", err)
	}
	if err := s.RestoreItems(removed); err != nil {
		t.Fatal(err)
	}
	back, err := s.Item(it.ID)
	if err != nil || back.CreatedAt != it.CreatedAt || !reflect.DeepEqual(back.Aliases, it.Aliases) || !reflect.DeepEqual(back.Slots, it.Slots) {
		t.Fatalf("restored %+v, %v", back, err)
	}
}

func TestImportMerges(t *testing.T) {
	s := openTest(t)
	mustCreate(t, s, ItemInput{Name: "ESP32", Slots: []string{"A-1"}, Tags: []string{"mcu"}})
	created, merged, err := s.ImportItems([]ItemInput{
		{Name: "esp32", Slots: []string{"B-2"}, Tags: []string{"wifi"}, Description: "Dev board"},
		{Name: "Velcro", Slots: []string{"C-3"}},
	})
	if err != nil || created != 1 || merged != 1 {
		t.Fatalf("import: %d created, %d merged, %v", created, merged, err)
	}
	items, _ := s.Items()
	esp := items[0]
	if esp.Name != "ESP32" || !reflect.DeepEqual(esp.Slots, []string{"A-1", "B-2"}) || !reflect.DeepEqual(esp.Tags, []string{"mcu", "wifi"}) || esp.Description != "Dev board" {
		t.Fatalf("merged %+v", esp)
	}
}

func TestBoxes(t *testing.T) {
	s := openTest(t)
	mustCreate(t, s, ItemInput{Name: "X", Slots: []string{"B-1", "A-2"}})
	if _, err := s.SetBox(Box{ID: "a", Slots: 24, Columns: 6}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetBox(Box{ID: "Z", Slots: 12, Columns: 4}); err != nil {
		t.Fatal(err)
	}
	boxes, err := s.Boxes()
	if err != nil {
		t.Fatal(err)
	}
	want := []Box{{"A", 24, 6}, {"B", 0, 0}, {"Z", 12, 4}}
	if !reflect.DeepEqual(boxes, want) {
		t.Fatalf("boxes = %v, want %v", boxes, want)
	}
	if err := s.DeleteBox("Z"); err != nil {
		t.Fatal(err)
	}
	// A box that still holds a part is kept, layout included.
	if err := s.DeleteBox("A"); err == nil {
		t.Fatal("a box holding a part was deleted")
	}
	if boxes, _ := s.Boxes(); !reflect.DeepEqual(boxes, []Box{{"A", 24, 6}, {"B", 0, 0}}) {
		t.Fatalf("boxes after delete = %v", boxes)
	}
	if _, err := s.SetBox(Box{ID: "1A"}); err == nil {
		t.Fatal("invalid box id accepted")
	}
}

func intPtr(n int) *int { return &n }

func TestChangeQuantity(t *testing.T) {
	s := openTest(t)
	counted := mustCreate(t, s, ItemInput{Name: "Resistor", Quantity: intPtr(2)})
	fresh := mustCreate(t, s, ItemInput{Name: "Velcro"})
	if fresh.Quantity != 0 || fresh.ToBuy {
		t.Fatalf("a new item starts at 0, off the shopping list: %+v", fresh)
	}
	state := func(it Item, err error) string {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return fmt.Sprintf("%d %v", it.Quantity, it.ToBuy)
	}
	steps := []struct {
		id    string
		delta int
		set   *int
		want  string
	}{
		{counted.ID, -1, nil, "1 false"},
		{counted.ID, -5, nil, "0 true"},         // never below zero; dropping to 0 puts it on the list
		{counted.ID, -1, nil, "0 true"},         // stays on the list
		{counted.ID, 0, intPtr(40), "40 false"}, // restocked
		{counted.ID, 0, intPtr(0), "0 true"},
		{fresh.ID, -1, nil, "0 false"}, // already at 0: nothing dropped
		{fresh.ID, 1, nil, "1 false"},
	}
	for i, st := range steps {
		if got := state(s.ChangeQuantity(st.id, st.delta, st.set)); got != st.want {
			t.Errorf("step %d: got %s, want %s", i, got, st.want)
		}
	}
	if _, err := s.ChangeQuantity(counted.ID, 0, intPtr(-2)); err == nil {
		t.Error("negative set accepted")
	}
	if _, err := s.ChangeQuantity("missing", 1, nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing item: %v", err)
	}

	// The editor saves the quantity with the rest: same rules.
	it, _ := s.Item(fresh.ID)
	if got := state(s.UpdateItem(it.ID, ItemInput{Name: it.Name, Quantity: intPtr(0)})); got != "0 true" {
		t.Errorf("edited down to 0: %s", got)
	}
	// Leaving the quantity out of an update keeps it.
	if got := state(s.UpdateItem(it.ID, ItemInput{Name: "Velcro strip"})); got != "0 true" {
		t.Errorf("update without quantity: %s", got)
	}
	// Restoring a snapshot puts the flag back as it was.
	removed, _ := s.DeleteItems([]string{counted.ID})
	if err := s.RestoreItems(removed); err != nil {
		t.Fatal(err)
	}
	if got := state(s.Item(counted.ID)); got != "0 true" {
		t.Errorf("restored: %s", got)
	}
	// Import keeps the existing count unless the file gives one.
	if _, _, err := s.ImportItems([]ItemInput{{Name: "resistor", Slots: []string{"A-1"}}}); err != nil {
		t.Fatal(err)
	}
	if got := state(s.Item(counted.ID)); got != "0 true" {
		t.Errorf("import without quantity: %s", got)
	}
	if _, _, err := s.ImportItems([]ItemInput{{Name: "resistor", Quantity: intPtr(7)}}); err != nil {
		t.Fatal(err)
	}
	if got := state(s.Item(counted.ID)); got != "7 false" {
		t.Errorf("import with quantity: %s", got)
	}
}

func TestPrice(t *testing.T) {
	s := openTest(t)
	it := mustCreate(t, s, ItemInput{Name: "LM317", Price: intPtr(85)})
	if it.Price != 85 {
		t.Fatalf("price = %d", it.Price)
	}
	// An update without a price keeps it; 0 clears it.
	if got, err := s.UpdateItem(it.ID, ItemInput{Name: "LM317"}); err != nil || got.Price != 85 {
		t.Fatalf("kept: %d %v", got.Price, err)
	}
	if got, err := s.UpdateItem(it.ID, ItemInput{Name: "LM317", Price: intPtr(0)}); err != nil || got.Price != 0 {
		t.Fatalf("cleared: %d %v", got.Price, err)
	}
	if _, err := s.CreateItem(ItemInput{Name: "X", Price: intPtr(-1)}); err == nil {
		t.Error("negative price accepted")
	}
	// Deleted and restored, the price comes back.
	s.UpdateItem(it.ID, ItemInput{Name: "LM317", Price: intPtr(90)})
	removed, _ := s.DeleteItems([]string{it.ID})
	if err := s.RestoreItems(removed); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Item(it.ID); got.Price != 90 {
		t.Errorf("restored price = %d", got.Price)
	}
}

func TestGear(t *testing.T) {
	s := openTest(t)
	tool := mustCreate(t, s, ItemInput{Kind: KindGear, Type: " Power  Tool ", Name: "Drill", Brand: " Makita ", Model: "DHP482", Serial: "A1 2", WarrantyUntil: "2027-03-31"})
	if tool.Kind != KindGear || tool.Type != "power tool" || tool.Brand != "Makita" || tool.Serial != "A1 2" || tool.Quantity != 0 {
		t.Fatalf("tool: %+v", tool)
	}
	for name, in := range map[string]ItemInput{
		"slot":        {Kind: KindGear, Name: "Saw", Slots: []string{"A-1"}},
		"quantity":    {Kind: KindGear, Name: "Saw", Quantity: intPtr(2)},
		"date":        {Kind: KindGear, Name: "Saw", WarrantyUntil: "03/2027"},
		"status":      {Kind: KindGear, Name: "Saw", Status: "stolen"},
		"kind":        {Kind: "gadget", Name: "Saw"},
		"part status": {Name: "Bolt", Status: "lost"},
		"part type":   {Name: "Bolt", Type: "watch"},
		"long type":   {Kind: KindGear, Name: "Saw", Type: strings.Repeat("x", MaxTypeLength+1)},
	} {
		if _, err := s.CreateItem(in); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// An update without a kind keeps it; an archived tool stays recorded, and
	// the statuses of older exports read as archived.
	got, err := s.UpdateItem(tool.ID, ItemInput{Name: "Drill", Brand: "Makita", Type: "tool", Status: "lost"})
	if err != nil || got.Kind != KindGear || got.Type != "tool" || got.Status != StatusArchived || got.Model != "" {
		t.Fatalf("update: %+v %v", got, err)
	}
	if err := s.MoveItems([]string{tool.ID}, "A-1"); err == nil {
		t.Error("a tool was moved to a slot")
	}
	if _, err := s.ChangeQuantity(tool.ID, 1, nil); err == nil {
		t.Error("a tool was counted")
	}
	// The kind of older exports: tool reads as gear of type tool.
	if _, _, err := s.ImportItems([]ItemInput{{Kind: "tool", Name: "Saw"}, {Kind: "tool", Type: "garden", Name: "Rake"}}); err != nil {
		t.Fatal(err)
	}
	items, _ := s.Items()
	types := map[string]string{}
	for _, it := range items {
		types[it.Name] = it.Kind + " " + it.Type
	}
	if types["Saw"] != "gear tool" || types["Rake"] != "gear garden" {
		t.Errorf("legacy import: %v", types)
	}
}

func TestAttachmentLifecycle(t *testing.T) {
	s := openTest(t)
	tool := mustCreate(t, s, ItemInput{Kind: KindGear, Name: "Drill"})
	a, err := s.AddAttachment(tool.ID, AttachmentInput{Filename: "../../etc/Facture.pdf", ContentType: "application/pdf", Label: "invoice"}, strings.NewReader("%PDF-1.4"))
	if err != nil {
		t.Fatal(err)
	}
	if a.Filename != "Facture.pdf" || a.Size != 8 {
		t.Fatalf("attachment: %+v", a)
	}
	if _, err := os.Stat(filepath.Join(s.files, a.ID)); err != nil {
		t.Fatalf("file on disk: %v", err)
	}
	got, _ := s.Item(tool.ID)
	if len(got.Attachments) != 1 {
		t.Fatalf("item attachments: %v", got.Attachments)
	}

	// Deleting the item keeps the file; undo brings it back with the item.
	removed, err := s.DeleteItems([]string{tool.ID})
	if err != nil {
		t.Fatal(err)
	}
	if n, err := s.PurgeAttachments(time.Now().Add(-AttachmentRetention)); err != nil || n != 0 {
		t.Fatalf("purged too early: %d %v", n, err)
	}
	if err := s.RestoreItems(removed); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Item(tool.ID); len(got.Attachments) != 1 {
		t.Fatalf("attachments after undo: %v", got.Attachments)
	}

	// Deleted attachments go once the retention has passed.
	if err := s.DeleteAttachment(a.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Item(tool.ID); len(got.Attachments) != 0 {
		t.Fatalf("deleted attachment still listed: %v", got.Attachments)
	}
	if n, err := s.PurgeAttachments(time.Now().Add(time.Minute)); err != nil || n != 1 {
		t.Fatalf("purge: %d %v", n, err)
	}
	if _, err := os.Stat(filepath.Join(s.files, a.ID)); !os.IsNotExist(err) {
		t.Fatalf("file still on disk: %v", err)
	}
	if _, err := s.RestoreAttachment(a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("restore after purge: %v", err)
	}

	// The files of a deleted item go too, after the retention.
	b, _ := s.AddAttachment(tool.ID, AttachmentInput{Filename: "manual.pdf", ContentType: "application/pdf"}, strings.NewReader("x"))
	s.DeleteItems([]string{tool.ID})
	if n, _ := s.PurgeAttachments(time.Now().Add(time.Minute)); n != 1 {
		t.Fatalf("orphans purged: %d", n)
	}
	if _, err := os.Stat(filepath.Join(s.files, b.ID)); !os.IsNotExist(err) {
		t.Fatal("orphan file still on disk")
	}
	if _, err := s.AddAttachment("missing", AttachmentInput{Filename: "a"}, strings.NewReader("x")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("attachment to a missing item: %v", err)
	}
}
