package db

import "database/sql"

// ImportItems adds items, merging each one into the existing item of the same
// name: slots, tags and aliases are combined, and empty fields are filled in.
// It returns how many items were created and how many were merged.
func (s *Store) ImportItems(inputs []ItemInput) (created, merged int, err error) {
	err = s.tx(func(tx *sql.Tx) error {
		for _, in := range inputs {
			c, err := in.clean()
			if err != nil {
				return invalid("%q: %s", in.Name, err.Error())
			}
			var id string
			err = tx.QueryRow(`SELECT id FROM items WHERE name_key = ?`, c.key).Scan(&id)
			if err == sql.ErrNoRows {
				id = newID()
				t := now()
				if _, err := tx.Exec(`INSERT INTO items (id, name, name_key, description, notes, quantity, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, c.name, c.key, c.description, c.notes, c.quantity, t, t); err != nil {
					return err
				}
				if err := writeLists(tx, id, c); err != nil {
					return err
				}
				created++
				continue
			}
			if err != nil {
				return err
			}
			existing, err := s.item(tx, id)
			if err != nil {
				return err
			}
			quantity := existing.Quantity
			if c.quantity != nil {
				quantity = c.quantity
			}
			m, err := ItemInput{
				Name:        existing.Name,
				Description: firstNonEmpty(existing.Description, c.description),
				Notes:       firstNonEmpty(existing.Notes, c.notes),
				Quantity:    quantity,
				Slots:       append(existing.Slots, slotStrings(c.slots)...),
				Tags:        append(existing.Tags, c.tags...),
				Aliases:     append(existing.Aliases, c.aliases...),
			}.clean()
			if err != nil {
				return invalid("%q: %s", in.Name, err.Error())
			}
			if _, err := tx.Exec(`UPDATE items SET description = ?, notes = ?, quantity = ?, updated_at = ? WHERE id = ?`,
				m.description, m.notes, m.quantity, now(), id); err != nil {
				return err
			}
			if err := writeLists(tx, id, m); err != nil {
				return err
			}
			merged++
		}
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	return created, merged, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func slotStrings(slots []Slot) []string {
	out := make([]string, len(slots))
	for i, sl := range slots {
		out[i] = sl.String()
	}
	return out
}
