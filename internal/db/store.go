// Package db persists the inventory (items, the slots they sit in, their tags
// and aliases, box layouts) and authentication data in a single SQLite file.
package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// ErrNotFound is returned when the requested row does not exist.
var ErrNotFound = errors.New("not found")

// ValidationError reports rejected input. Its message is meant for the user.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, args ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, args...)}
}

// DuplicateError is returned when an item with the same name already exists.
type DuplicateError struct {
	Name       string
	ExistingID string
}

func (e *DuplicateError) Error() string {
	return fmt.Sprintf("An item named %q already exists", e.Name)
}

// Store is safe for concurrent use.
type Store struct {
	db *sql.DB
}

// querier is implemented by both *sql.DB and *sql.Tx.
type querier interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

// Open opens (creating it if needed) the database at path and migrates it.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}
	dsn := path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)"
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	// A single connection serializes every statement. For a personal inventory
	// this costs nothing and rules out "database is locked" errors.
	sqlDB.SetMaxOpenConns(1)

	s := &Store{db: sqlDB}
	if err := s.migrate(); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("migrate database: %w", err)
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error {
	return s.db.Close()
}

// Ping checks that the database answers.
func (s *Store) Ping() error {
	return s.db.Ping()
}

// tx runs fn inside a transaction, committed only if fn returns nil.
func (s *Store) tx(fn func(tx *sql.Tx) error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// migrations are applied in order; PRAGMA user_version records how many ran.
// Never edit a released migration: append a new one instead.
var migrations = []string{
	// 1: base schema.
	`CREATE TABLE items (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		name_key TEXT NOT NULL UNIQUE,
		description TEXT NOT NULL DEFAULT '',
		notes TEXT NOT NULL DEFAULT '',
		stock TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);

	CREATE TABLE item_slots (
		item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
		box TEXT NOT NULL,
		number INTEGER NOT NULL,
		PRIMARY KEY (item_id, box, number)
	);
	CREATE INDEX idx_item_slots_slot ON item_slots(box, number);

	CREATE TABLE item_tags (
		item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
		tag TEXT NOT NULL,
		PRIMARY KEY (item_id, tag)
	);
	CREATE INDEX idx_item_tags_tag ON item_tags(tag);

	CREATE TABLE item_aliases (
		item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
		alias TEXT NOT NULL,
		position INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (item_id, alias)
	);

	CREATE TABLE boxes (
		id TEXT PRIMARY KEY,
		slots INTEGER NOT NULL DEFAULT 0,
		columns INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE auth_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	CREATE TABLE auth_sessions (
		token TEXT PRIMARY KEY,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);`,

	// 2: a count replaces the stock level; "out" becomes 0 (shopping list).
	`ALTER TABLE items ADD COLUMN quantity INTEGER; -- NULL: not counted
	UPDATE items SET quantity = 0 WHERE stock = 'out';
	ALTER TABLE items DROP COLUMN stock;`,

	// 3: every item is counted (0 by default), and the shopping list is a flag
	// set when the quantity drops to 0, so items created at 0 stay off it.
	`ALTER TABLE items ADD COLUMN to_buy INTEGER NOT NULL DEFAULT 0;
	UPDATE items SET to_buy = 1 WHERE quantity = 0;
	UPDATE items SET quantity = 0 WHERE quantity IS NULL;`,
}

func (s *Store) migrate() error {
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	for i := version; i < len(migrations); i++ {
		err := s.tx(func(tx *sql.Tx) error {
			if _, err := tx.Exec(migrations[i]); err != nil {
				return err
			}
			_, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", i+1))
			return err
		})
		if err != nil {
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
	}
	return nil
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on supported platforms
	}
	return hex.EncodeToString(b)
}

// Timestamps are stored as UTC RFC 3339 text, which sorts chronologically.
func now() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func exists(q querier, query string, args ...any) (bool, error) {
	var one int
	err := q.QueryRow(query, args...).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}
