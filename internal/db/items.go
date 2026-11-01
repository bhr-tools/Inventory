package db

import (
	"database/sql"
	"errors"
	"sort"
	"strings"
	"time"
)

// Item kinds. A part sits in slots and is counted; gear (a tool, a watch, a
// laptop…) is only recorded: type, brand, reference, serial number, warranty
// and attached files.
const (
	KindPart = "part"
	KindGear = "gear"
	// kindLegacyTool is the kind of gear before migration 6; older CSV exports
	// still carry it.
	kindLegacyTool = "tool"
)

// StatusArchived marks gear that is gone (broken, lost, sold) but kept on
// record with its serial number and invoice. The empty status means in use.
const StatusArchived = "archived"

// legacyStatuses were the gear statuses before archiving replaced them; older
// CSV exports still carry them.
var legacyStatuses = map[string]bool{"broken": true, "lost": true}

// Item is a part or a piece of gear.
type Item struct {
	ID            string       `json:"id"`
	Kind          string       `json:"kind"`
	Name          string       `json:"name"`
	Description   string       `json:"description"`
	Notes         string       `json:"notes"`
	Quantity      int          `json:"quantity"`
	Price         int          `json:"price"`  // purchase price in cents, per unit for a part; 0: not set
	ToBuy         bool         `json:"to_buy"` // on the shopping list: its quantity dropped to 0
	Slots         []string     `json:"slots"`
	Tags          []string     `json:"tags"`
	Aliases       []string     `json:"aliases"`
	Type          string       `json:"type"` // gear only: "tool", "watch"… lower case
	Brand         string       `json:"brand"`
	Model         string       `json:"model"`
	Serial        string       `json:"serial"`
	WarrantyUntil string       `json:"warranty_until"` // YYYY-MM-DD or ""
	Status        string       `json:"status"`
	Attachments   []Attachment `json:"attachments"`
	CreatedAt     string       `json:"created_at"`
	UpdatedAt     string       `json:"updated_at"`
}

// ItemInput is the editable part of an item.
type ItemInput struct {
	Kind          string   `json:"kind"` // omitted: part for a new item, unchanged otherwise
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	Notes         string   `json:"notes"`
	Quantity      *int     `json:"quantity"` // omitted: 0 for a new item, unchanged otherwise
	Price         *int     `json:"price"`    // cents; omitted: none for a new item, unchanged otherwise
	Slots         []string `json:"slots"`
	Tags          []string `json:"tags"`
	Aliases       []string `json:"aliases"`
	Type          string   `json:"type"`
	Brand         string   `json:"brand"`
	Model         string   `json:"model"`
	Serial        string   `json:"serial"`
	WarrantyUntil string   `json:"warranty_until"`
	Status        string   `json:"status"`
}

// shoppingFlag tells whether an item is on the shopping list once its
// quantity goes from old to updated: it joins when the quantity drops to 0
// and leaves as soon as it is above 0 again.
func shoppingFlag(old, updated int, toBuy bool) bool {
	if updated > 0 {
		return false
	}
	return toBuy || old > 0
}

// cleanItem is a validated ItemInput.
type cleanItem struct {
	kind, name, key, description, notes string
	typ, brand, model, serial, warranty string
	status                              string
	quantity, price                     *int
	slots                               []Slot
	tags, aliases                       []string
}

func (in ItemInput) clean() (cleanItem, error) {
	var c cleanItem
	c.name = strings.Join(strings.Fields(in.Name), " ")
	if c.name == "" {
		return c, invalid("The name cannot be empty")
	}
	if len([]rune(c.name)) > MaxNameLength {
		return c, invalid("Names are at most %d characters long", MaxNameLength)
	}
	c.key = nameKey(c.name)
	c.description = strings.TrimSpace(in.Description)
	if len([]rune(c.description)) > MaxDescriptionLength {
		return c, invalid("Descriptions are at most %d characters long", MaxDescriptionLength)
	}
	c.notes = strings.TrimSpace(in.Notes)
	if len([]rune(c.notes)) > MaxNotesLength {
		return c, invalid("Notes are at most %d characters long", MaxNotesLength)
	}
	c.kind = strings.TrimSpace(in.Kind)
	if c.kind == kindLegacyTool {
		c.kind = KindGear
		if strings.TrimSpace(in.Type) == "" {
			in.Type = "tool"
		}
	}
	if c.kind != "" && c.kind != KindPart && c.kind != KindGear {
		return c, invalid("The kind is part or gear")
	}
	c.typ = strings.ToLower(strings.Join(strings.Fields(in.Type), " "))
	if len([]rune(c.typ)) > MaxTypeLength {
		return c, invalid("The type is at most %d characters long", MaxTypeLength)
	}
	for _, f := range []struct {
		dst   *string
		src   string
		label string
	}{{&c.brand, in.Brand, "brand"}, {&c.model, in.Model, "reference"}, {&c.serial, in.Serial, "serial number"}} {
		*f.dst = strings.Join(strings.Fields(f.src), " ")
		if len([]rune(*f.dst)) > MaxGearFieldLength {
			return c, invalid("The %s is at most %d characters long", f.label, MaxGearFieldLength)
		}
	}
	c.warranty = strings.TrimSpace(in.WarrantyUntil)
	if c.warranty != "" {
		if _, err := time.Parse(time.DateOnly, c.warranty); err != nil {
			return c, invalid("The warranty end is a date like 2027-03-31")
		}
	}
	c.status = strings.ToLower(strings.TrimSpace(in.Status))
	if legacyStatuses[c.status] {
		c.status = StatusArchived
	}
	if c.status != "" && c.status != StatusArchived {
		return c, invalid("The status is archived or empty")
	}
	if in.Quantity != nil {
		if *in.Quantity < 0 || *in.Quantity > MaxQuantity {
			return c, invalid("The quantity goes from 0 to %d", MaxQuantity)
		}
		q := *in.Quantity
		c.quantity = &q
	}
	if in.Price != nil {
		if *in.Price < 0 || *in.Price > MaxPrice {
			return c, invalid("The price goes from 0 to %d", MaxPrice/100)
		}
		p := *in.Price
		c.price = &p
	}
	var err error
	if c.slots, err = parseSlots(in.Slots); err != nil {
		return c, err
	}
	if c.tags, err = normalizeTags(in.Tags); err != nil {
		return c, err
	}
	if c.aliases, err = normalizeAliases(in.Aliases, c.name); err != nil {
		return c, err
	}
	return c, nil
}

// Items returns every item, ordered by first slot then name (items without a
// slot come last).
func (s *Store) Items() ([]Item, error) {
	return s.loadItems(s.db, "")
}

// Item returns one item.
func (s *Store) Item(id string) (Item, error) {
	return s.item(s.db, id)
}

func (s *Store) item(q querier, id string) (Item, error) {
	items, err := s.loadItems(q, id)
	if err != nil {
		return Item{}, err
	}
	if len(items) == 0 {
		return Item{}, ErrNotFound
	}
	return items[0], nil
}

// loadItems loads all items, or only the one with id when id is not empty.
func (s *Store) loadItems(q querier, id string) ([]Item, error) {
	itemFilter, filter, args := "", "", []any{}
	if id != "" {
		itemFilter, filter, args = " WHERE id = ?", " WHERE item_id = ?", []any{id}
	}
	byID := map[string]*Item{}
	var order []*Item

	rows, err := q.Query(`SELECT id, kind, name, description, notes, COALESCE(quantity, 0), to_buy, price,
		type, brand, model, serial, warranty_until, status, created_at, updated_at FROM items`+itemFilter, args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		it := &Item{Slots: []string{}, Tags: []string{}, Aliases: []string{}, Attachments: []Attachment{}}
		if err := rows.Scan(&it.ID, &it.Kind, &it.Name, &it.Description, &it.Notes, &it.Quantity, &it.ToBuy, &it.Price,
			&it.Type, &it.Brand, &it.Model, &it.Serial, &it.WarrantyUntil, &it.Status, &it.CreatedAt, &it.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		byID[it.ID] = it
		order = append(order, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	firstSlot := map[string]Slot{}
	err = eachRow(q, `SELECT item_id, box, number FROM item_slots`+filter+` ORDER BY box, number`, args, func(r *sql.Rows) error {
		var itemID string
		var sl Slot
		if err := r.Scan(&itemID, &sl.Box, &sl.Number); err != nil {
			return err
		}
		if it := byID[itemID]; it != nil {
			if len(it.Slots) == 0 {
				firstSlot[itemID] = sl
			}
			it.Slots = append(it.Slots, sl.String())
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = eachRow(q, `SELECT item_id, tag FROM item_tags`+filter+` ORDER BY tag`, args, func(r *sql.Rows) error {
		var itemID, tag string
		if err := r.Scan(&itemID, &tag); err != nil {
			return err
		}
		if it := byID[itemID]; it != nil {
			it.Tags = append(it.Tags, tag)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = eachRow(q, `SELECT item_id, alias FROM item_aliases`+filter+` ORDER BY position, alias`, args, func(r *sql.Rows) error {
		var itemID, alias string
		if err := r.Scan(&itemID, &alias); err != nil {
			return err
		}
		if it := byID[itemID]; it != nil {
			it.Aliases = append(it.Aliases, alias)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	err = eachRow(q, `SELECT `+attachmentColumns+` FROM attachments`+filter+andLive(filter)+` ORDER BY created_at, filename`, args, func(r *sql.Rows) error {
		a, err := scanAttachment(r)
		if err != nil {
			return err
		}
		if it := byID[a.ItemID]; it != nil {
			it.Attachments = append(it.Attachments, a)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	sort.SliceStable(order, func(i, j int) bool {
		a, okA := firstSlot[order[i].ID]
		b, okB := firstSlot[order[j].ID]
		if okA != okB {
			return okA
		}
		if okA && a != b {
			return slotLess(a, b)
		}
		return nameKey(order[i].Name) < nameKey(order[j].Name)
	})
	items := make([]Item, len(order))
	for i, it := range order {
		items[i] = *it
	}
	return items, nil
}

func eachRow(q querier, query string, args []any, fn func(*sql.Rows) error) error {
	rows, err := q.Query(query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := fn(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// CreateItem adds an item. A name already used by another item (ignoring
// case, accents and spacing) is refused with a *DuplicateError.
func (s *Store) CreateItem(in ItemInput) (Item, error) {
	c, err := in.clean()
	if err != nil {
		return Item{}, err
	}
	if err := c.forKind(KindPart); err != nil {
		return Item{}, err
	}
	id := newID()
	err = s.tx(func(tx *sql.Tx) error {
		if err := checkUniqueName(tx, c, ""); err != nil {
			return err
		}
		t := now()
		if _, err := tx.Exec(`INSERT INTO items (id, kind, name, name_key, description, notes, quantity, price,
				type, brand, model, serial, warranty_until, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, c.kind, c.name, c.key, c.description, c.notes, c.quantityOr(0), c.priceOr(0),
			c.typ, c.brand, c.model, c.serial, c.warranty, c.status, t, t); err != nil {
			return err
		}
		return writeLists(tx, id, c)
	})
	if err != nil {
		return Item{}, err
	}
	return s.Item(id)
}

// UpdateItem replaces every editable field of an item.
func (s *Store) UpdateItem(id string, in ItemInput) (Item, error) {
	c, err := in.clean()
	if err != nil {
		return Item{}, err
	}
	err = s.tx(func(tx *sql.Tx) error {
		if err := checkUniqueName(tx, c, id); err != nil {
			return err
		}
		old, toBuy, kind, err := quantityOf(tx, id)
		if err != nil {
			return err
		}
		if err := c.forKind(kind); err != nil {
			return err
		}
		q := c.quantityOr(old)
		toBuy = shoppingFlag(old, q, toBuy) && c.kind == KindPart
		if _, err := tx.Exec(`UPDATE items SET kind = ?, name = ?, name_key = ?, description = ?, notes = ?, quantity = ?, to_buy = ?,
				price = COALESCE(?, price), type = ?, brand = ?, model = ?, serial = ?, warranty_until = ?, status = ?, updated_at = ? WHERE id = ?`,
			c.kind, c.name, c.key, c.description, c.notes, q, toBuy,
			c.price, c.typ, c.brand, c.model, c.serial, c.warranty, c.status, now(), id); err != nil {
			return err
		}
		return writeLists(tx, id, c)
	})
	if err != nil {
		return Item{}, err
	}
	return s.Item(id)
}

// forKind finishes the validation once the kind is known (on update, it may
// come from the stored item): gear has no slot, no count and no shopping
// flag; a part has no type and no archive.
func (c *cleanItem) forKind(kind string) error {
	if c.kind == "" {
		c.kind = kind
	}
	if c.kind == KindGear {
		if len(c.slots) > 0 {
			return invalid("Gear has no slot: it is only recorded")
		}
		if c.quantity != nil && *c.quantity != 0 {
			return invalid("Gear is not counted")
		}
		zero := 0
		c.quantity = &zero
		return nil
	}
	if c.status != "" {
		return invalid("Only gear can be archived")
	}
	if c.typ != "" {
		return invalid("Only gear has a type")
	}
	return nil
}

func (c cleanItem) priceOr(fallback int) int {
	if c.price == nil {
		return fallback
	}
	return *c.price
}

func (c cleanItem) quantityOr(fallback int) int {
	if c.quantity == nil {
		return fallback
	}
	return *c.quantity
}

// quantityOf reads the quantity, shopping flag and kind of an item.
func quantityOf(q querier, id string) (quantity int, toBuy bool, kind string, err error) {
	err = q.QueryRow(`SELECT COALESCE(quantity, 0), to_buy, kind FROM items WHERE id = ?`, id).Scan(&quantity, &toBuy, &kind)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return quantity, toBuy, kind, err
}

func checkUniqueName(q querier, c cleanItem, selfID string) error {
	var existing string
	err := q.QueryRow(`SELECT id FROM items WHERE name_key = ? AND id != ?`, c.key, selfID).Scan(&existing)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return &DuplicateError{Name: c.name, ExistingID: existing}
}

// writeLists replaces the slots, tags and aliases of an item.
func writeLists(tx *sql.Tx, id string, c cleanItem) error {
	for _, table := range []string{"item_slots", "item_tags", "item_aliases"} {
		if _, err := tx.Exec(`DELETE FROM `+table+` WHERE item_id = ?`, id); err != nil {
			return err
		}
	}
	for _, sl := range c.slots {
		if _, err := tx.Exec(`INSERT INTO item_slots (item_id, box, number) VALUES (?, ?, ?)`, id, sl.Box, sl.Number); err != nil {
			return err
		}
	}
	for _, tag := range c.tags {
		if _, err := tx.Exec(`INSERT INTO item_tags (item_id, tag) VALUES (?, ?)`, id, tag); err != nil {
			return err
		}
	}
	for i, alias := range c.aliases {
		if _, err := tx.Exec(`INSERT INTO item_aliases (item_id, alias, position) VALUES (?, ?, ?)`, id, alias, i); err != nil {
			return err
		}
	}
	return nil
}

// DeleteItems removes items and returns them as they were, for undo.
func (s *Store) DeleteItems(ids []string) ([]Item, error) {
	var removed []Item
	err := s.tx(func(tx *sql.Tx) error {
		for _, id := range ids {
			it, err := s.item(tx, id)
			if errors.Is(err, ErrNotFound) {
				continue
			}
			if err != nil {
				return err
			}
			if _, err := tx.Exec(`DELETE FROM items WHERE id = ?`, id); err != nil {
				return err
			}
			// The files stay until the purge, so that undo brings them back.
			if _, err := tx.Exec(`UPDATE attachments SET orphaned_at = ? WHERE item_id = ?`, now(), id); err != nil {
				return err
			}
			removed = append(removed, it)
		}
		return nil
	})
	if removed == nil {
		removed = []Item{}
	}
	return removed, err
}

// RestoreItems puts back items returned by DeleteItems, keeping their ids and
// creation dates. An item whose name was reused in the meantime is refused.
func (s *Store) RestoreItems(items []Item) error {
	return s.tx(func(tx *sql.Tx) error {
		for _, it := range items {
			c, err := ItemInput{Kind: it.Kind, Name: it.Name, Description: it.Description, Notes: it.Notes, Quantity: &it.Quantity, Price: &it.Price,
				Slots: it.Slots, Tags: it.Tags, Aliases: it.Aliases, Type: it.Type, Brand: it.Brand, Model: it.Model, Serial: it.Serial,
				WarrantyUntil: it.WarrantyUntil, Status: it.Status}.clean()
			if err != nil {
				return err
			}
			if err := c.forKind(KindPart); err != nil {
				return err
			}
			if it.ID == "" {
				it.ID = newID()
			}
			if err := checkUniqueName(tx, c, it.ID); err != nil {
				return err
			}
			created := it.CreatedAt
			if created == "" {
				created = now()
			}
			if _, err := tx.Exec(`INSERT INTO items (id, kind, name, name_key, description, notes, quantity, price, to_buy,
					type, brand, model, serial, warranty_until, status, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, name_key = excluded.name_key,
					description = excluded.description, notes = excluded.notes, quantity = excluded.quantity, price = excluded.price,
					to_buy = excluded.to_buy, type = excluded.type, brand = excluded.brand, model = excluded.model, serial = excluded.serial,
					warranty_until = excluded.warranty_until, status = excluded.status, updated_at = excluded.updated_at`,
				it.ID, c.kind, c.name, c.key, c.description, c.notes, c.quantityOr(0), c.priceOr(0), it.ToBuy && c.quantityOr(0) == 0 && c.kind == KindPart,
				c.typ, c.brand, c.model, c.serial, c.warranty, c.status, created, now()); err != nil {
				return err
			}
			if _, err := tx.Exec(`UPDATE attachments SET orphaned_at = '' WHERE item_id = ?`, it.ID); err != nil {
				return err
			}
			if err := writeLists(tx, it.ID, c); err != nil {
				return err
			}
		}
		return nil
	})
}

// MoveItems puts items in the given slot, replacing every slot they were in.
func (s *Store) MoveItems(ids []string, slot string) error {
	sl, err := ParseSlot(slot)
	if err != nil {
		return err
	}
	return s.tx(func(tx *sql.Tx) error {
		for _, id := range ids {
			res, err := tx.Exec(`UPDATE items SET updated_at = ? WHERE id = ? AND kind = 'part'`, now(), id)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				if _, _, kind, err := quantityOf(tx, id); err == nil && kind == KindGear {
					return invalid("Gear has no slot")
				}
				return ErrNotFound
			}
			if _, err := tx.Exec(`DELETE FROM item_slots WHERE item_id = ?`, id); err != nil {
				return err
			}
			if _, err := tx.Exec(`INSERT INTO item_slots (item_id, box, number) VALUES (?, ?, ?)`, id, sl.Box, sl.Number); err != nil {
				return err
			}
		}
		return nil
	})
}

// SwapSlots exchanges the contents of two slots. An item stored in both stays
// in both.
func (s *Store) SwapSlots(a, b string) error {
	sa, err := ParseSlot(a)
	if err != nil {
		return err
	}
	sb, err := ParseSlot(b)
	if err != nil {
		return err
	}
	if sa == sb {
		return nil
	}
	return s.tx(func(tx *sql.Tx) error {
		inA, err := slotItems(tx, sa)
		if err != nil {
			return err
		}
		inB, err := slotItems(tx, sb)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM item_slots WHERE (box = ? AND number = ?) OR (box = ? AND number = ?)`,
			sa.Box, sa.Number, sb.Box, sb.Number); err != nil {
			return err
		}
		insert := func(ids []string, to Slot) error {
			for _, id := range ids {
				if _, err := tx.Exec(`INSERT INTO item_slots (item_id, box, number) VALUES (?, ?, ?)`, id, to.Box, to.Number); err != nil {
					return err
				}
				if _, err := tx.Exec(`UPDATE items SET updated_at = ? WHERE id = ?`, now(), id); err != nil {
					return err
				}
			}
			return nil
		}
		if err := insert(inA, sb); err != nil {
			return err
		}
		return insert(inB, sa)
	})
}

func slotItems(q querier, sl Slot) ([]string, error) {
	var ids []string
	err := eachRow(q, `SELECT item_id FROM item_slots WHERE box = ? AND number = ?`, []any{sl.Box, sl.Number}, func(r *sql.Rows) error {
		var id string
		if err := r.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
		return nil
	})
	return ids, err
}

// TagItems adds and removes tags on several items at once.
func (s *Store) TagItems(ids, add, remove []string) error {
	addTags, err := normalizeTags(add)
	if err != nil {
		return err
	}
	removeTags, err := normalizeTags(remove)
	if err != nil {
		return err
	}
	return s.tx(func(tx *sql.Tx) error {
		for _, id := range ids {
			res, err := tx.Exec(`UPDATE items SET updated_at = ? WHERE id = ?`, now(), id)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return ErrNotFound
			}
			for _, tag := range removeTags {
				if _, err := tx.Exec(`DELETE FROM item_tags WHERE item_id = ? AND tag = ?`, id, tag); err != nil {
					return err
				}
			}
			for _, tag := range addTags {
				if _, err := tx.Exec(`INSERT OR IGNORE INTO item_tags (item_id, tag) VALUES (?, ?)`, id, tag); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

// ChangeQuantity adds delta to the quantity of an item, or sets it when set
// is not nil. It never goes below zero; dropping to zero puts the item on the
// shopping list. The read and the write share one transaction, so quick
// presses from two devices add up.
func (s *Store) ChangeQuantity(id string, delta int, set *int) (Item, error) {
	if set != nil && (*set < 0 || *set > MaxQuantity) {
		return Item{}, invalid("The quantity goes from 0 to %d", MaxQuantity)
	}
	if delta < -MaxQuantity || delta > MaxQuantity {
		return Item{}, invalid("The quantity goes from 0 to %d", MaxQuantity)
	}
	err := s.tx(func(tx *sql.Tx) error {
		old, toBuy, kind, err := quantityOf(tx, id)
		if err != nil {
			return err
		}
		if kind == KindGear {
			return invalid("Gear is not counted")
		}
		q := min(MaxQuantity, max(0, old+delta))
		if set != nil {
			q = *set
		}
		_, err = tx.Exec(`UPDATE items SET quantity = ?, to_buy = ?, updated_at = ? WHERE id = ?`,
			q, shoppingFlag(old, q, toBuy), now(), id)
		return err
	})
	if err != nil {
		return Item{}, err
	}
	return s.Item(id)
}
