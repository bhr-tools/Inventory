package db

import (
	"errors"
	"path/filepath"
	"reflect"
	"testing"
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
	if _, err := s.UpdateItem(it.ID, ItemInput{Name: "Résistance 10K", Stock: "low"}); err != nil {
		t.Fatalf("renaming an item to itself: %v", err)
	}
	if _, err := s.CreateItem(ItemInput{Name: "X", Stock: "lots"}); err == nil {
		t.Fatal("invalid stock accepted")
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
	if _, err := s.SetBox(Box{ID: "1A"}); err == nil {
		t.Fatal("invalid box id accepted")
	}
}
