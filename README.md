# Inventory

A self-hosted inventory for parts stored in compartment boxes, and a record of your gear. Every
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
- **No duplicates:** while you type a new item's name, look-alike items are
  listed; open one to add to it instead of creating a twin.
- **Hierarchical tags:** `#electronic/mcu` is found by `#electronic` and `#mcu`.
- **Quantities:** every item has a count (0 by default): `+` / `-` on an item,
  or `x` to type it.
- **Shopping list:** an item whose quantity *drops* to 0 goes to the second
  tab (an item created at 0 does not). Set a quantity when you bought some, or
  delete it if you won't buy it again.
- **Gear register:** a second tab records valuables (no slot, no count): tools,
  a watch, a 3D printer, a laptop… Each has a free **type** (the types already
  used are offered) and the list comes grouped by type. Brand, reference,
  serial number and warranty end are shown in the item's details. Gear that is
  broken, lost or sold is **archived** (`A`): it leaves the list but stays on
  record with its serial number and invoice, under “Show archived” or
  `is:archived`.
- **Attached files:** invoices, manuals, photos, datasheets on any item.
  Drop them on the details, or press `f` (on a phone: camera, photos or files).
  They open through a signed link, which also works in the viewer iOS opens
  from a home screen app, and are served sandboxed.
- **Boxes as grids:** see free slots, swap two slots with `s` or by dragging.
  An empty box can be deleted (`D` or the button under its size); a box that
  still holds parts says how many and shows them, to move them first.
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
| `makita`, `dhp482`, `sn4821` | gear by brand, reference, or serial (from its start, never fuzzy) |
| `type:watch` | gear of one type; `is:tool` is short for `type:tool` |
| `is:gear`, `is:part` | one kind |
| `is:archived` | archived gear (broken, lost, sold) |
| `is:warranty`, `has:file` | gear still under warranty; items with attachments |

The query is kept in the URL (`/?q=A-12`), so a slot can be bookmarked or put
in a QR code on the box.

## Adding and editing

Adding (`a`, or `+ Add` on a phone) and editing (`e`, or `Edit` on an item's
page) open the same form, on a computer and on a phone:

- **Name:** look-alike items are listed as you type (`ESP32 clone` →
  ESP32-WROOM), so a typo does not make a second copy; open one to add to it.
  A name that already exists, ignoring case and accents, cannot be added again.
- **Slot:** pick a box, then a slot on its map (free slots are dashed). Tick
  “several slots” to keep a part in more than one. Slots are never typed:
  boxes and their sizes are created in **Boxes** (`b`, or the ⋯ menu), and a
  form only offers boxes that exist.
- **Quantity** with − / +, **tags** with completion from the existing ones,
  and, folded below, other names, a description and notes.
- **Price** (optional): what one piece of a part cost, or what a piece of gear
  cost. It is only shown in the details, with the worth of the stock for a
  part (`€3.50 · €17.50 for 5`), and goes in the CSV `price` column.
- **Gear** takes a type, a brand, a reference, a serial number and a warranty
  end instead of a slot and a count, and can be archived from the same form.

Moving (`m`) and swapping (`s`) use the same box map: tap a free slot to move
there, a used one to swap the two slots.

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
| `a` | Add an item |
| `+` / `-` | One more / one less (at 0, it goes to the shopping list) |
| `x` | Type the quantity |
| `1` / `2` / `3` (`&` / `é` / `"` on AZERTY) | Parts / gear / shopping |
| `f` / `o` | Attach files / open the first file |
| `m` | Move, on the map of the box |
| `s` | Swap with another slot, on the map |
| `t` | Add tags, or remove them with `-tag` |
| `A` | Archive gear, or restore it |
| `d` / `u` | Delete / undo |
| `b` | Boxes (grid: `hjkl` move, `[` `]` switch box, `s` swap, `a` add, `D` delete an empty box) |
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
node --test tests/js/*.test.mjs  # search and look-alikes
tests/e2e/run.sh                 # Chromium, desktop and phone (screenshots in tests/e2e/out)
```
