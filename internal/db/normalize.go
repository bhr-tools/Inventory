package db

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Limits on user input.
const (
	MaxNameLength        = 200
	MaxDescriptionLength = 2000
	MaxNotesLength       = 10000
	MaxAliasLength       = 100
	MaxTagLength         = 60
	MaxBoxIDLength       = 8
	MaxSlotNumber        = 9999
	MaxBoxSlots          = 999
	MaxListLength        = 50 // slots, tags or aliases of one item
	MaxQuantity          = 1_000_000
	MaxPrice             = 100_000_000 // cents: 1 000 000.00
	MaxGearFieldLength   = 100         // brand, model, serial
	MaxTypeLength        = 40
)

// Slot is one compartment of a box, written "A-12".
type Slot struct {
	Box    string
	Number int
}

func (s Slot) String() string { return fmt.Sprintf("%s-%d", s.Box, s.Number) }

var (
	// "A-12", "a 12", "B2-3": any box id followed by a separator.
	slotWithSeparator = regexp.MustCompile(`^([A-Z][A-Z0-9]*)\s*[-\s]\s*(\d+)$`)
	// "A12", "ab3": a box id made of letters only needs no separator.
	slotCompact = regexp.MustCompile(`^([A-Z]+)(\d+)$`)
	boxPattern  = regexp.MustCompile(`^[A-Z][A-Z0-9]*$`)
)

// ParseSlot reads a slot reference such as "A-12", "a12" or "B2-3".
func ParseSlot(text string) (Slot, error) {
	t := strings.ToUpper(strings.TrimSpace(text))
	m := slotWithSeparator.FindStringSubmatch(t)
	if m == nil {
		m = slotCompact.FindStringSubmatch(t)
	}
	if m == nil {
		return Slot{}, invalid("%q is not a slot: write it like A-12", text)
	}
	if len(m[1]) > MaxBoxIDLength {
		return Slot{}, invalid("Box ids are at most %d characters long", MaxBoxIDLength)
	}
	n, err := strconv.Atoi(m[2])
	if err != nil || n < 1 || n > MaxSlotNumber {
		return Slot{}, invalid("Slot numbers go from 1 to %d", MaxSlotNumber)
	}
	return Slot{Box: m[1], Number: n}, nil
}

// ParseBoxID validates a box id such as "A" or "B2".
func ParseBoxID(text string) (string, error) {
	id := strings.ToUpper(strings.TrimSpace(text))
	if !boxPattern.MatchString(id) || len(id) > MaxBoxIDLength {
		return "", invalid("A box id is a letter followed by up to %d letters or digits", MaxBoxIDLength-1)
	}
	return id, nil
}

// parseSlots parses, deduplicates and sorts a list of slot references.
func parseSlots(texts []string) ([]Slot, error) {
	seen := map[Slot]bool{}
	var slots []Slot
	for _, t := range texts {
		if strings.TrimSpace(t) == "" {
			continue
		}
		s, err := ParseSlot(t)
		if err != nil {
			return nil, err
		}
		if !seen[s] {
			seen[s] = true
			slots = append(slots, s)
		}
	}
	if len(slots) > MaxListLength {
		return nil, invalid("An item can be in at most %d slots", MaxListLength)
	}
	sortSlots(slots)
	return slots, nil
}

func sortSlots(slots []Slot) {
	for i := 1; i < len(slots); i++ {
		for j := i; j > 0 && slotLess(slots[j], slots[j-1]); j-- {
			slots[j], slots[j-1] = slots[j-1], slots[j]
		}
	}
}

func slotLess(a, b Slot) bool {
	if a.Box != b.Box {
		return a.Box < b.Box
	}
	return a.Number < b.Number
}

// NormalizeTag turns "#Electronic / MCU" into "electronic/mcu". Tags are
// hierarchical: "electronic/mcu" is found when filtering by "electronic".
func NormalizeTag(text string) (string, error) {
	t := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text), "#")))
	var parts []string
	for _, part := range strings.Split(t, "/") {
		part = strings.Join(strings.Fields(part), "-")
		if part != "" {
			parts = append(parts, part)
		}
	}
	tag := strings.Join(parts, "/")
	if tag == "" {
		return "", invalid("A tag cannot be empty")
	}
	if len([]rune(tag)) > MaxTagLength {
		return "", invalid("Tags are at most %d characters long", MaxTagLength)
	}
	for _, r := range tag {
		if !(unicode.IsLetter(r) || unicode.IsDigit(r) || strings.ContainsRune("-_./+", r)) {
			return "", invalid("Tag %q contains %q: use letters, digits, - _ . + and / for sub-tags", tag, r)
		}
	}
	return tag, nil
}

func normalizeTags(texts []string) ([]string, error) {
	seen := map[string]bool{}
	var tags []string
	for _, t := range texts {
		if strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(t), "#")) == "" {
			continue
		}
		tag, err := NormalizeTag(t)
		if err != nil {
			return nil, err
		}
		if !seen[tag] {
			seen[tag] = true
			tags = append(tags, tag)
		}
	}
	if len(tags) > MaxListLength {
		return nil, invalid("An item can have at most %d tags", MaxListLength)
	}
	return tags, nil
}

func normalizeAliases(texts []string, name string) ([]string, error) {
	seen := map[string]bool{nameKey(name): true}
	var aliases []string
	for _, t := range texts {
		a := strings.Join(strings.Fields(t), " ")
		if a == "" {
			continue
		}
		if len([]rune(a)) > MaxAliasLength {
			return nil, invalid("Aliases are at most %d characters long", MaxAliasLength)
		}
		if k := nameKey(a); !seen[k] {
			seen[k] = true
			aliases = append(aliases, a)
		}
	}
	if len(aliases) > MaxListLength {
		return nil, invalid("An item can have at most %d aliases", MaxListLength)
	}
	return aliases, nil
}

// nameKey is the form under which two names count as the same item: case,
// accents and spacing are ignored, so "Résistance 10k" and "resistance  10K"
// collide.
func nameKey(name string) string {
	return strings.Join(strings.Fields(foldAccents(strings.ToLower(name))), " ")
}

var accentFolder = strings.NewReplacer(
	"à", "a", "á", "a", "â", "a", "ã", "a", "ä", "a", "å", "a", "æ", "ae",
	"ç", "c", "è", "e", "é", "e", "ê", "e", "ë", "e",
	"ì", "i", "í", "i", "î", "i", "ï", "i", "ñ", "n",
	"ò", "o", "ó", "o", "ô", "o", "õ", "o", "ö", "o", "ø", "o", "œ", "oe",
	"ù", "u", "ú", "u", "û", "u", "ü", "u", "ý", "y", "ÿ", "y", "ß", "ss",
)

func foldAccents(s string) string { return accentFolder.Replace(s) }
