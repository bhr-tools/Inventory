# Inventory

A self-hosted inventory for parts and tools stored in compartment boxes. Every
compartment has an id like `A-12` (box `A`, slot `12`). Type a slot to see
what it holds; type what you are looking for, even half-remembered, to find its
slot.

Built like [Get Done](https://github.com/bhr-tools/GetDone): **slow tech**, a
single Go binary with embedded SQLite and web app, Rosé Pine themes following
the system, and full Vim navigation.

- **fzf-like search:** one field, results on every keystroke, the item under the
  cursor previewed on the right with its neighbouring slots.
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

The query is kept in the URL (`/?q=A-12`), so a slot can be bookmarked or put
in a QR code on the box.

## Adding parts

Press `a` and type one line:

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
| `1` / `2` (`&` / `é` on AZERTY) | Inventory / Shopping list |
| `m` | Move to a slot |
| `s` | Swap two slots |
| `t` | Add tags, or remove them with `-tag` |
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

## Import and export

The menu exports the whole inventory as CSV (`name, slots, tags, aliases,
quantity, description, notes`; an empty quantity is 0 for a new item and
keeps the count of an existing one; slots and tags separated by spaces, aliases by
semicolons). Importing the same format merges rows into existing items of the
same name.

## Development

```sh
go test ./...                    # store, API, routes
node --test tests/js/*.test.mjs  # search, suggestions, Quick Add parser
tests/e2e/run.sh                 # Chromium, desktop and phone (screenshots in tests/e2e/out)
```
