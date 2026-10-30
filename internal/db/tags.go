package db

import (
	"database/sql"
	"strings"
)

// RenameTag renames a tag and its sub-tags: "electronic" to "elec" also turns
// "electronic/mcu" into "elec/mcu". Renaming onto an existing tag merges them.
func (s *Store) RenameTag(from, to string) error {
	oldTag, err := NormalizeTag(from)
	if err != nil {
		return err
	}
	newTag, err := NormalizeTag(to)
	if err != nil {
		return err
	}
	if oldTag == newTag {
		return nil
	}
	if strings.HasPrefix(newTag, oldTag+"/") {
		return invalid("A tag cannot be moved under itself")
	}
	return s.tx(func(tx *sql.Tx) error {
		// The new name, then any sub-tag rewritten under it.
		if _, err := tx.Exec(`INSERT OR IGNORE INTO item_tags (item_id, tag)
			SELECT item_id, ? || substr(tag, length(?) + 1) FROM item_tags
			WHERE tag = ? OR substr(tag, 1, length(?) + 1) = ? || '/'`,
			newTag, oldTag, oldTag, oldTag, oldTag); err != nil {
			return err
		}
		_, err := tx.Exec(`DELETE FROM item_tags WHERE tag = ? OR substr(tag, 1, length(?) + 1) = ? || '/'`, oldTag, oldTag, oldTag)
		return err
	})
}

// DeleteTag removes a tag from every item. Its sub-tags are kept.
func (s *Store) DeleteTag(tag string) error {
	t, err := NormalizeTag(tag)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`DELETE FROM item_tags WHERE tag = ?`, t)
	return err
}

// Box is the layout of a box: how many slots it has and how many columns its
// grid shows. A box that was never configured has no row and zero values.
type Box struct {
	ID      string `json:"id"`
	Slots   int    `json:"slots"`
	Columns int    `json:"columns"`
}

// Boxes returns every box that is configured or holds an item, ordered by id.
func (s *Store) Boxes() ([]Box, error) {
	boxes := []Box{}
	err := eachRow(s.db, `SELECT id, MAX(slots), MAX(columns) FROM (
			SELECT id, slots, columns FROM boxes
			UNION ALL
			SELECT DISTINCT box, 0, 0 FROM item_slots
		) GROUP BY id ORDER BY id`, nil, func(r *sql.Rows) error {
		var b Box
		if err := r.Scan(&b.ID, &b.Slots, &b.Columns); err != nil {
			return err
		}
		boxes = append(boxes, b)
		return nil
	})
	return boxes, err
}

// SetBox configures the layout of a box.
func (s *Store) SetBox(b Box) (Box, error) {
	id, err := ParseBoxID(b.ID)
	if err != nil {
		return Box{}, err
	}
	if b.Slots < 0 || b.Slots > MaxBoxSlots {
		return Box{}, invalid("A box has between 0 and %d slots", MaxBoxSlots)
	}
	if b.Columns < 0 || b.Columns > 50 {
		return Box{}, invalid("A box grid has between 0 and 50 columns")
	}
	b.ID = id
	_, err = s.db.Exec(`INSERT INTO boxes (id, slots, columns) VALUES (?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET slots = excluded.slots, columns = excluded.columns`, b.ID, b.Slots, b.Columns)
	return b, err
}

// DeleteBox forgets the layout of a box. Its items keep their slots.
func (s *Store) DeleteBox(id string) error {
	boxID, err := ParseBoxID(id)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`DELETE FROM boxes WHERE id = ?`, boxID)
	return err
}
