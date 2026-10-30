package db

import (
	"database/sql"
	"errors"
	"sort"
	"strings"
)

// Item is a kind of part or tool, stored in one or more slots.
type Item struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Notes       string   `json:"notes"`
	Stock       string   `json:"stock"`
	Slots       []string `json:"slots"`
	Tags        []string `json:"tags"`
	Aliases     []string `json:"aliases"`
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
}

// ItemInput is the editable part of an item.
type ItemInput struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Notes       string   `json:"notes"`
	Stock       string   `json:"stock"`
	Slots       []string `json:"slots"`
	Tags        []string `json:"tags"`
	Aliases     []string `json:"aliases"`
}

// cleanItem is a validated ItemInput.
type cleanItem struct {
	name, key, description, notes, stock string
	slots                                []Slot
	tags, aliases                        []string
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
	c.stock = strings.ToLower(strings.TrimSpace(in.Stock))
	if !stockLevels[c.stock] {
		return c, invalid("Stock must be plenty, low, out or empty")
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

	rows, err := q.Query(`SELECT id, name, description, notes, stock, created_at, updated_at FROM items`+itemFilter, args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		it := &Item{Slots: []string{}, Tags: []string{}, Aliases: []string{}}
		if err := rows.Scan(&it.ID, &it.Name, &it.Description, &it.Notes, &it.Stock, &it.CreatedAt, &it.UpdatedAt); err != nil {
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
	id := newID()
	err = s.tx(func(tx *sql.Tx) error {
		if err := checkUniqueName(tx, c, ""); err != nil {
			return err
		}
		t := now()
		if _, err := tx.Exec(`INSERT INTO items (id, name, name_key, description, notes, stock, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, c.name, c.key, c.description, c.notes, c.stock, t, t); err != nil {
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
		res, err := tx.Exec(`UPDATE items SET name = ?, name_key = ?, description = ?, notes = ?, stock = ?, updated_at = ? WHERE id = ?`,
			c.name, c.key, c.description, c.notes, c.stock, now(), id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return writeLists(tx, id, c)
	})
	if err != nil {
		return Item{}, err
	}
	return s.Item(id)
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
			c, err := ItemInput{Name: it.Name, Description: it.Description, Notes: it.Notes, Stock: it.Stock,
				Slots: it.Slots, Tags: it.Tags, Aliases: it.Aliases}.clean()
			if err != nil {
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
			if _, err := tx.Exec(`INSERT INTO items (id, name, name_key, description, notes, stock, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key,
					description = excluded.description, notes = excluded.notes, stock = excluded.stock,
					updated_at = excluded.updated_at`,
				it.ID, c.name, c.key, c.description, c.notes, c.stock, created, now()); err != nil {
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
			res, err := tx.Exec(`UPDATE items SET updated_at = ? WHERE id = ?`, now(), id)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
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
