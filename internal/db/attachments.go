package db

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MaxAttachmentSize is the largest accepted file.
const MaxAttachmentSize = 25 << 20

// Attachment labels. The empty string means "other".
var attachmentLabels = map[string]bool{"": true, "invoice": true, "manual": true, "photo": true, "datasheet": true}

// Attachment is a file attached to an item: an invoice, a manual, a photo, a
// datasheet. The file lives in the attachments directory under its id; the
// name it was uploaded with is only shown.
type Attachment struct {
	ID          string `json:"id"`
	ItemID      string `json:"item_id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
	Label       string `json:"label"`
	CreatedAt   string `json:"created_at"`
	URL         string `json:"url,omitempty"` // set by the API: a signed link that works without the session cookie
}

const attachmentColumns = `id, item_id, filename, content_type, size, label, created_at`

func scanAttachment(r interface{ Scan(...any) error }) (Attachment, error) {
	var a Attachment
	err := r.Scan(&a.ID, &a.ItemID, &a.Filename, &a.ContentType, &a.Size, &a.Label, &a.CreatedAt)
	return a, err
}

// andLive adds the condition hiding deleted attachments to a WHERE clause
// (or starts one).
func andLive(filter string) string {
	if filter == "" {
		return " WHERE deleted_at = ''"
	}
	return " AND deleted_at = ''"
}

// AttachmentInput describes an uploaded file.
type AttachmentInput struct {
	Filename    string
	ContentType string
	Label       string
}

func cleanFilename(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, `\`, "/"))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, strings.TrimSpace(name))
	if name == "" || name == "." || name == "/" {
		name = "file"
	}
	if r := []rune(name); len(r) > 200 {
		name = string(r[:200])
	}
	return name
}

// GuessLabel picks a label from the file name and type when none was given.
func GuessLabel(filename, contentType string) string {
	n := strings.ToLower(filename)
	switch {
	case strings.Contains(n, "facture") || strings.Contains(n, "invoice") || strings.Contains(n, "receipt") || strings.Contains(n, "ticket"):
		return "invoice"
	case strings.Contains(n, "notice") || strings.Contains(n, "manual") || strings.Contains(n, "guide"):
		return "manual"
	case strings.Contains(n, "datasheet"):
		return "datasheet"
	case strings.HasPrefix(contentType, "image/"):
		return "photo"
	}
	return ""
}

// AddAttachment stores a file for an item. The content is streamed to a
// temporary file, synced, then renamed, so a failed upload leaves nothing
// behind. Files above MaxAttachmentSize are refused.
func (s *Store) AddAttachment(itemID string, in AttachmentInput, content io.Reader) (Attachment, error) {
	if !attachmentLabels[in.Label] {
		return Attachment{}, invalid("The label is invoice, manual, photo, datasheet or empty")
	}
	if ok, err := exists(s.db, `SELECT 1 FROM items WHERE id = ?`, itemID); err != nil {
		return Attachment{}, err
	} else if !ok {
		return Attachment{}, ErrNotFound
	}
	if err := os.MkdirAll(s.files, 0o750); err != nil {
		return Attachment{}, fmt.Errorf("create attachments directory: %w", err)
	}
	tmp, err := os.CreateTemp(s.files, ".upload-*")
	if err != nil {
		return Attachment{}, err
	}
	defer os.Remove(tmp.Name()) // a no-op once renamed
	size, err := io.Copy(tmp, io.LimitReader(content, MaxAttachmentSize+1))
	if err == nil && size > MaxAttachmentSize {
		err = invalid("Files are at most %d MB", MaxAttachmentSize>>20)
	}
	if err == nil && size == 0 {
		err = invalid("The file is empty")
	}
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return Attachment{}, err
	}

	a := Attachment{
		ID:          newID(),
		ItemID:      itemID,
		Filename:    cleanFilename(in.Filename),
		ContentType: in.ContentType,
		Size:        size,
		Label:       in.Label,
		CreatedAt:   now(),
	}
	if err := os.Rename(tmp.Name(), s.attachmentPath(a.ID)); err != nil {
		return Attachment{}, err
	}
	_, err = s.db.Exec(`INSERT INTO attachments (`+attachmentColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.ItemID, a.Filename, a.ContentType, a.Size, a.Label, a.CreatedAt)
	if err != nil {
		os.Remove(s.attachmentPath(a.ID))
		return Attachment{}, err
	}
	_, _ = s.db.Exec(`UPDATE items SET updated_at = ? WHERE id = ?`, now(), itemID)
	return a, nil
}

func (s *Store) attachmentPath(id string) string {
	return filepath.Join(s.files, id)
}

// GetAttachment returns a live attachment.
func (s *Store) GetAttachment(id string) (Attachment, error) {
	a, err := scanAttachment(s.db.QueryRow(`SELECT `+attachmentColumns+` FROM attachments WHERE id = ? AND deleted_at = ''`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Attachment{}, ErrNotFound
	}
	return a, err
}

// OpenAttachment opens the file of a live attachment.
func (s *Store) OpenAttachment(id string) (Attachment, *os.File, error) {
	a, err := s.GetAttachment(id)
	if err != nil {
		return Attachment{}, nil, err
	}
	f, err := os.Open(s.attachmentPath(a.ID))
	if errors.Is(err, os.ErrNotExist) {
		return Attachment{}, nil, ErrNotFound
	}
	return a, f, err
}

// UpdateAttachment renames or relabels an attachment; nil leaves a field as it is.
func (s *Store) UpdateAttachment(id string, filename, label *string) (Attachment, error) {
	a, err := s.GetAttachment(id)
	if err != nil {
		return Attachment{}, err
	}
	if filename != nil {
		a.Filename = cleanFilename(*filename)
	}
	if label != nil {
		if !attachmentLabels[*label] {
			return Attachment{}, invalid("The label is invoice, manual, photo, datasheet or empty")
		}
		a.Label = *label
	}
	_, err = s.db.Exec(`UPDATE attachments SET filename = ?, label = ? WHERE id = ?`, a.Filename, a.Label, a.ID)
	return a, err
}

// DeleteAttachment moves an attachment to the trash; RestoreAttachment takes
// it back until the purge removes the file.
func (s *Store) DeleteAttachment(id string) error {
	res, err := s.db.Exec(`UPDATE attachments SET deleted_at = ? WHERE id = ? AND deleted_at = ''`, now(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) RestoreAttachment(id string) (Attachment, error) {
	res, err := s.db.Exec(`UPDATE attachments SET deleted_at = '' WHERE id = ?`, id)
	if err != nil {
		return Attachment{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Attachment{}, ErrNotFound
	}
	return s.GetAttachment(id)
}

// AttachmentRetention is how long deleted attachments, and the attachments
// of deleted items, are kept for undo.
const AttachmentRetention = 30 * 24 * time.Hour

// PurgeAttachments removes the files deleted, or orphaned by their item's
// deletion, before cutoff, and any leftover upload. It returns how many
// attachments were removed.
func (s *Store) PurgeAttachments(cutoff time.Time) (int, error) {
	c := cutoff.UTC().Format(time.RFC3339)
	var ids []string
	err := eachRow(s.db, `SELECT id FROM attachments
		WHERE (deleted_at != '' AND deleted_at < ?)
		   OR (orphaned_at != '' AND orphaned_at < ? AND item_id NOT IN (SELECT id FROM items))`,
		[]any{c, c}, func(r *sql.Rows) error {
			var id string
			if err := r.Scan(&id); err != nil {
				return err
			}
			ids = append(ids, id)
			return nil
		})
	if err != nil {
		return 0, err
	}
	for _, id := range ids {
		if err := os.Remove(s.attachmentPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
		if _, err := s.db.Exec(`DELETE FROM attachments WHERE id = ?`, id); err != nil {
			return 0, err
		}
	}
	// Uploads interrupted by a crash.
	if leftovers, _ := filepath.Glob(filepath.Join(s.files, ".upload-*")); leftovers != nil {
		for _, f := range leftovers {
			if info, err := os.Stat(f); err == nil && info.ModTime().Before(time.Now().Add(-time.Hour)) {
				os.Remove(f)
			}
		}
	}
	return len(ids), nil
}
