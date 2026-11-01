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
				if err := c.forKind(KindPart); err != nil {
					return invalid("%q: %s", in.Name, err.Error())
				}
				id = newID()
				t := now()
				if _, err := tx.Exec(`INSERT INTO items (id, kind, name, name_key, description, notes, quantity, price,
						type, brand, model, serial, warranty_until, status, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					id, c.kind, c.name, c.key, c.description, c.notes, c.quantityOr(0), c.priceOr(0),
					c.typ, c.brand, c.model, c.serial, c.warranty, c.status, t, t); err != nil {
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
			// A file without a quantity keeps the current one.
			quantity := c.quantityOr(existing.Quantity)
			// A price in the file replaces the one recorded; none keeps it.
			price := existing.Price
			if c.price != nil && *c.price > 0 {
				price = *c.price
			}
			m, err := ItemInput{
				Kind:          existing.Kind,
				Type:          firstNonEmpty(c.typ, existing.Type),
				Brand:         firstNonEmpty(c.brand, existing.Brand),
				Model:         firstNonEmpty(c.model, existing.Model),
				Serial:        firstNonEmpty(c.serial, existing.Serial),
				WarrantyUntil: firstNonEmpty(c.warranty, existing.WarrantyUntil),
				Status:        firstNonEmpty(c.status, existing.Status),
				Name:          existing.Name,
				Description:   firstNonEmpty(existing.Description, c.description),
				Notes:         firstNonEmpty(existing.Notes, c.notes),
				Quantity:      &quantity,
				Slots:         append(existing.Slots, slotStrings(c.slots)...),
				Tags:          append(existing.Tags, c.tags...),
				Aliases:       append(existing.Aliases, c.aliases...),
			}.clean()
			if err == nil {
				err = m.forKind(existing.Kind)
			}
			if err != nil {
				return invalid("%q: %s", in.Name, err.Error())
			}
			if _, err := tx.Exec(`UPDATE items SET description = ?, notes = ?, quantity = ?, to_buy = ?, price = ?,
					type = ?, brand = ?, model = ?, serial = ?, warranty_until = ?, status = ?, updated_at = ? WHERE id = ?`,
				m.description, m.notes, quantity, shoppingFlag(existing.Quantity, quantity, existing.ToBuy) && m.kind == KindPart, price,
				m.typ, m.brand, m.model, m.serial, m.warranty, m.status, now(), id); err != nil {
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
