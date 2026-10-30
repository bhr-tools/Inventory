# Inventory

A self-hosted inventory for parts and tools stored in compartment boxes. Every
compartment has an id like `A-12` (box `A`, slot `12`). Type a slot to see
what it holds; type what you are looking for, even half-remembered, to find its
slot.

Built like [Get Done](https://github.com/bhr-tools/GetDone): **slow tech**, a
single Go binary with embedded SQLite and web app, Rosé Pine themes following
the system, and full Vim navigation. It reads like a component datasheet:
ruled tables grouped by box, IBM Plex (shipped with the app, no font service).

- **fzf-like search:** one field, results on every keystroke, the item under the
  cursor previewed on the right with its neighbouring slots. On a phone, the
  tabs sit at the bottom and an item opens as a page (swipe from the left edge
  to go back).
- **Forgiving:** prefixes, typos (`condesateur`), accents, scattered letters
  (`scrtch`), and aliases: give a part the names you might remember it by.
- **No duplicates:** while you type a new part, look-alike items are listed;
  pick one to add the new slots and tags to it instead of creating a twin.
- **Hierarchical tags:** `#electronic/mcu` is found by `#electronic` and `#mcu`.
- **Quantities:** every item has a count (0 by default): `+` / `-` on an item,
  or `x` to type it.
- **Shopping list:** an item whose quantity *drops* to 0 goes to the second
  tab (an item created at 0 does not). Set a quantity when you bought some, or
  delete it if you won't buy it again.
- **Tools register:** a second tab records tools (no slot, no count): brand,
  reference, serial number and warranty end, shown in the tool's details. A
  tool that is broken, lost or sold is **archived** (`A`): it leaves the list
  but stays on record with its serial number and invoice, under “Show
  archived” or `is:archived`.
- **Attached files:** invoices, manuals, photos, datasheets on any tool or part.
  Drop them on the details, or press `f` (on a phone: camera, photos or files).
  They open through a signed link, which also works in the viewer iOS opens
  from a home screen app, and are served sandboxed.
- **Boxes as grids:** see free slots, swap two slots with `s` or by dragging.
- **Undo** for every change.

## Search syntax

| Query | Finds |
|---|---|
| `cond 100nf` | items matching every word (name, aliases, tags, description, notes) |
| `A-12` or `a12` | what is in slot A-12 (first), then text matches |
| `#electronic` | a tag and its sub-tags; `#mcu` also finds `electronic/mcu` |
| `@A` | items in box A |
| `-smd` | excludes items mentioning “smd” |
| `is:out`, `is:tobuy` | quantity 0, or on the shopping list |
| `is:empty` | free slots of the boxes whose size is set |
| `is:untagged`, `is:unplaced` | items without tags, or without a slot |
| `makita`, `dhp482`, `sn4821` | tools by brand, reference, or serial (from its start, never fuzzy) |
| `is:tool`, `is:part` | one kind |
| `is:archived` | archived tools (broken, lost, sold) |
| `is:warranty`, `has:file` | tools still under warranty; items with attachments |

The query is kept in the URL (`/?q=A-12`), so a slot can be bookmarked or put
in a QR code on the box.

## Adding parts

On a phone, `+ Add` opens a short form: the name lists look-alike items as you
type, the slot is picked among the free ones of a box (or on its map), and the
count is set with − / +. On a computer, press `a` and type one line:

```
ESP32-WROOM B-2 #electronic/mcu ~esp ~"wifi board" x5
```

`B-2` is a slot (several allowed), `#tag` a tag, `~alias` another name (quoted
for spaces), `x5` the quantity (0 when left out). Everything else is the name. Under the field, a
guide shows what was understood for each field and, for the ones not filled
yet, their syntax with an example; the field being typed is highlighted. A
slot needs its dash (`A-12`) unless its box already exists, so names like
`M3 screw` or `LM317` stay names.

Typing `A-` lists the slots of box A, free ones first; `#` lists existing tags.
`Tab` completes. Under them, existing items that look like the name are listed:
`↓` then `Enter` adds the new slots, tags and aliases to that item (and keeps
the typed name as an alias); a quantity is added to its count. A name identical to an existing one, ignoring case
and accents, always adds to it.

For a tool (Quick Add opened from the tools tab):

```
Drill brand:Makita ref:DHP482 sn:"A1 2" until:2027-03 #power
```

`until:` is the warranty end: `2027`, `2027-03` or `2027-03-31` (the last day
of the year or month when not given). After adding a tool, its details open,
ready for the invoice.

## Keyboard shortcuts

Press `?` in the app for the cheatsheet.

| Key | Action |
|---|---|
| `/` | Search |
| `↓` / `↑` (or `Ctrl+J` / `Ctrl+K`) | Move while typing |
| `Enter` / `Esc` | Leave the search (`Esc` again clears it) |
| `j` / `k`, `gg` / `G` | Next / previous, first / last |
| `Enter` or `e` | Edit the item |
| `Space` | Select (actions then apply to the selection) |
| `a` | Add parts |
| `+` / `-` | One more / one less (at 0, it goes to the shopping list) |
| `x` | Type the quantity |
| `1` / `2` / `3` (`&` / `é` / `"` on AZERTY) | Parts / tools / shopping |
| `f` / `o` | Attach files / open the first file |
| `m` | Move to a slot |
| `s` | Swap two slots |
| `t` | Add tags, or remove them with `-tag` |
| `A` | Archive a tool, or restore it |
| `d` / `u` | Delete / undo |
| `b` | Boxes (grid: `hjkl` move, `[` `]` switch box, `s` swap, `a` add) |
| `T` | Tags (rename, merge, delete) |

## Running

```sh
nix run github:bhr-tools/Inventory -- -port 8080 -data-dir ./data
```

or `go run ./cmd/server`. Flags (or environment variables): `-host` (`HOST`),
`-port` (`PORT`), `-data-dir` (`DATA_DIR`), `-db` (`DB_PATH`), `-no-auth`
(`NO_AUTH=true`). On first visit the app asks for a master password.

### NixOS

```nix
{
  inputs.inventory.url = "github:bhr-tools/Inventory";
  # ...
  imports = [ inventory.nixosModules.default ];
  services.inventory = {
    enable = true;
    instances.default.port = 8080;
  };
}
```

## Files and backups

Attachments live in `<data-dir>/attachments/`, one file per attachment named
by its id; the database keeps their names and labels. Files are limited to
25 MB. A deleted attachment, or the attachments of a deleted item, stay 30
days for undo, then a daily purge removes them. Back up the data directory
(database and `attachments/`), not only the database.

## Import and export

The menu exports the whole inventory as CSV (`name, kind, slots, tags, aliases,
quantity, brand, model, serial, warranty_until, status, description, notes`;
`status` is `archived` or empty, and the `broken` or `lost` of older exports
read as archived; an empty quantity is 0 for a new item and
keeps the count of an existing one; slots and tags separated by spaces, aliases by
semicolons). Importing the same format merges rows into existing items of the
same name.

## Development

```sh
go test ./...                    # store, API, routes
node --test tests/js/*.test.mjs  # search, suggestions, Quick Add parser
tests/e2e/run.sh                 # Chromium, desktop and phone (screenshots in tests/e2e/out)
```
