"""End-to-end smoke test of the web app in Chromium (desktop and phone).

Run against a fresh instance (see tests/e2e/run.sh). Screenshots are written
to $OUT.
"""
import os
import sys
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:18931")
OUT = os.environ.get("OUT", "out")
PASSWORD = "correct horse"
PDF = b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"
errors = []

SEED = [
    {"name": "Condensateur céramique 100nF", "slots": ["A-12"], "tags": ["electronic/passive/capacitor"], "aliases": ["condo", "decoupling cap"], "quantity": 100},
    {"name": "Condensateur chimique 10µF", "slots": ["A-13"], "tags": ["electronic/passive/capacitor"]},
    {"name": "Résistance 10k", "slots": ["A-11"], "tags": ["electronic/passive/resistor"]},
    {"name": "ESP32-WROOM", "slots": ["B-2"], "tags": ["electronic/mcu"], "aliases": ["esp", "wifi board"], "quantity": 1,
     "description": "Dev board, USB-C", "notes": "Flash with esptool.\nBoot button: hold GPIO0."},
    {"name": "Arduino Nano", "slots": ["B-3"], "tags": ["electronic/mcu"], "quantity": 2},
    {"name": "Scratch adhésif noir", "slots": ["C-3"], "tags": ["fixing"], "aliases": ["velcro", "hook and loop"]},
    {"name": "Vis M3x10", "slots": ["C-1", "C-2"], "tags": ["hardware/screw"], "description": "Tête cylindrique, inox"},
    {"name": "Fer à souder", "tags": ["tool"]},
    {"name": "Pince coupante", "slots": ["D-1"], "tags": ["tool"]},
]


def watch(page):
    page.on("console", lambda m: m.type in ("error", "warning") and errors.append(f"console {m.type}: {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"page error: {e}"))


def shot(page, name):
    page.wait_for_timeout(250)
    page.screenshot(path=f"{OUT}/{name}.png")


def rows(page):
    return page.locator("#results .row:not(.thead)")


def azerty(page, key):
    """Presses a key Playwright has no keycode for, like the é of the AZERTY 2 key."""
    page.evaluate("k => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))", key)


def type_search(page, text):
    page.locator("#search").fill(text)
    page.wait_for_timeout(100)


def desktop(browser):
    ctx = browser.new_context(viewport={"width": 1280, "height": 820}, color_scheme="dark")
    page = ctx.new_page()
    watch(page)
    page.goto(BASE)

    # First run: choose a password.
    page.locator(".auth input").nth(0).fill(PASSWORD)
    page.locator(".auth input").nth(1).fill(PASSWORD)
    page.locator(".auth button[type=submit]").click()
    expect(page.locator(".auth")).to_have_count(0)

    for item in SEED:
        res = page.request.post(f"{BASE}/api/items", data=item)
        assert res.status == 201, res.text()
    assert page.request.put(f"{BASE}/api/boxes/A", data={"slots": 24, "columns": 6}).ok
    page.reload()
    expect(rows(page)).to_have_count(len(SEED))
    expect(page.locator("#search")).to_be_focused()
    shot(page, "01-all")

    # fzf-like search, typos, aliases, filters.
    type_search(page, "cond")
    expect(rows(page)).to_have_count(2)
    expect(page.locator("#results .row.cursor mark").first).to_have_text("Cond")
    shot(page, "02-search")
    type_search(page, "condesateur ceram")
    expect(rows(page).first).to_contain_text("céramique")
    type_search(page, "velcro")
    expect(rows(page).first).to_contain_text("Scratch")
    type_search(page, "#mcu")
    expect(rows(page)).to_have_count(2)
    type_search(page, "#tool -fer")
    expect(rows(page)).to_have_count(1)
    type_search(page, "is:out")
    expect(rows(page)).to_have_count(6)  # items created without a quantity are at 0
    type_search(page, "is:tobuy")
    expect(rows(page)).to_have_count(0)  # ...but none dropped to 0
    type_search(page, "is:empty @A")
    expect(rows(page)).to_have_count(21)

    # A slot: its contents and its neighbours.
    type_search(page, "a13")
    expect(page.locator(".slot-banner")).to_contain_text("1 item")
    expect(page.locator(".preview")).to_contain_text("A-12")
    expect(page.locator(".preview")).to_contain_text("A-14")
    shot(page, "03-slot")
    type_search(page, "a-20")
    expect(page.locator(".slot-banner")).to_contain_text("empty")

    # ↓ while typing moves the cursor; the preview follows.
    type_search(page, "esp")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("ArrowUp")
    expect(page.locator(".preview-title")).to_have_text("ESP32-WROOM")
    expect(page.locator(".preview")).to_contain_text("hold GPIO0")

    # The item form: the name lists look-alikes as it is typed.
    page.keyboard.press("Escape")
    page.keyboard.press("a")
    form = page.locator(".item-modal")
    expect(form.locator(".modal-title")).to_have_text("New part")
    name = form.locator("input").first
    expect(name).to_be_focused()
    name.type("Condensateur ceramic 100 nF")
    expect(form.locator(".look-alike").first).to_contain_text("Condensateur céramique 100nF")
    shot(page, "04-form-similar")
    # The exact same name (case and accents aside) cannot be added twice.
    name.fill("esp32-wroom")
    expect(form.locator(".look-alike.exact")).to_contain_text("Already in the inventory")
    expect(form.locator(".modal-action")).to_be_disabled()

    # A new part: its slot is picked on the map of an existing box.
    name.fill("Multimètre")
    form.locator(".map-box", has_text="Box A").click()
    form.locator('.map-cell[aria-label^="A-1:"]').click()
    expect(form.locator(".chip-slot")).to_have_count(1)
    expect(form.locator(".chip-slot")).to_contain_text("A-1")
    form.locator('input[aria-label="Tag"]').type("to")
    form.locator(".pick.suggest", has_text="tool").click()
    expect(form.locator(".tag-chip").first).to_contain_text("tool")
    shot(page, "05-form-new")
    page.keyboard.press("Control+Enter")
    expect(page.locator(".toast")).to_contain_text("Added “Multimètre” to A-1")
    expect(form).to_have_count(0)

    # Editing is the same form: ESP32 gets 4 more and a second slot, C-4.
    type_search(page, "esp32")
    page.keyboard.press("Escape")
    page.keyboard.press("e")
    expect(form.locator(".modal-title")).to_have_text("Edit part")
    form.locator(".stepper input").fill("5")
    form.locator(".field-check", has_text="several slots").click()
    form.locator(".map-box", has_text="Box C").click()
    form.locator('.map-cell[aria-label^="C-4:"]').click()
    expect(form.locator(".chip-slot")).to_have_count(2)
    # A unit price, typed with a comma; shown in the details only, with the stock's worth.
    form.locator('input[aria-label="Price"]').fill("abc")
    form.locator(".modal-action").click()
    expect(form.locator(".form-error")).to_contain_text("amount")
    form.locator('input[aria-label="Price"]').fill("3,5")
    form.locator(".modal-action").click()
    expect(page.locator(".toast")).to_contain_text("Saved “ESP32-WROOM”")
    expect(page.locator(".preview .ds-sub")).to_contain_text("B-2, C-4")
    expect(page.locator(".preview .spec")).to_contain_text("Unit price")
    expect(page.locator(".preview .spec")).to_contain_text("17.50")
    expect(page.locator("#results")).not_to_contain_text("3.50")
    shot(page, "06a-price")

    type_search(page, "multi")
    expect(rows(page)).to_have_count(1)
    expect(rows(page).first).to_contain_text("A-1")

    # Delete, then undo.
    page.keyboard.press("Escape")
    page.keyboard.press("d")
    expect(page.locator(".toast")).to_contain_text("Deleted “Multimètre”")
    expect(rows(page)).to_have_count(0)
    page.keyboard.press("u")
    expect(rows(page)).to_have_count(1)

    # Move on the map: tap A-5, then confirm.
    page.keyboard.press("m")
    page.locator('.map-modal .map-cell[aria-label^="A-5:"]').click()
    page.locator(".map-confirm .button").click()
    expect(page.locator(".toast")).to_contain_text("Moved “Multimètre” to A-5")
    expect(rows(page).first).to_contain_text("A-5")

    # Edit: a name another item has is refused; the notes are under "more".
    page.keyboard.press("e")
    name = form.locator("input").first
    name.fill("Pince coupante")
    expect(form.locator(".look-alike.exact")).to_contain_text("Another item has this name")
    name.fill("Multimètre Fluke")
    form.locator(".form-more summary").click()
    form.locator('textarea[aria-label="Notes"]').fill("Fuse: 440 mA")
    shot(page, "06-form-edit")
    page.keyboard.press("Control+Enter")
    expect(page.locator(".toast")).to_contain_text("Saved “Multimètre Fluke”")
    type_search(page, "440")
    expect(rows(page)).to_have_count(1)

    # Box grid and swap with the keyboard: s on A-5, l, s on A-6.
    page.keyboard.press("Escape")
    page.keyboard.press("b")
    expect(page.locator(".grid .cell")).to_have_count(24)
    expect(page.locator(".grid .cell.cursor")).to_contain_text("Multimètre Fluke")
    page.keyboard.press("s")
    page.keyboard.press("l")
    expect(page.locator(".grid-hint")).to_contain_text("swap A-5 with")
    shot(page, "07-grid")
    page.keyboard.press("s")
    expect(page.locator(".toast")).to_contain_text("Swapped A-5 and A-6")
    expect(page.locator(".grid .cell").nth(5)).to_contain_text("Multimètre Fluke")
    page.keyboard.press("]")
    expect(page.locator(".grid-tab.active")).to_have_text("B")
    # A box holding parts cannot be deleted; an empty one can, with undo.
    expect(page.locator(".grid-delete .button")).to_be_disabled()
    expect(page.locator(".grid-delete")).to_contain_text("inside: move them first")
    page.locator(".grid-tab.new").click()
    page.locator(".dialog input").fill("Z")
    page.keyboard.press("Enter")
    expect(page.locator(".grid-tab.active")).to_have_text("Z")
    shot(page, "07a-delete-box")
    page.keyboard.press("D")
    page.locator(".dialog .button.danger").click()
    expect(page.locator(".toast").last).to_contain_text("Deleted box Z")
    expect(page.locator(".grid-tab", has_text="Z")).to_have_count(0)
    page.locator(".toast .toast-action").last.click()
    expect(page.locator(".grid-tab", has_text="Z")).to_have_count(1)
    page.locator(".grid-tab", has_text="Z").click()
    page.locator(".grid-delete .button").click()
    page.locator(".dialog .button.danger").click()
    expect(page.locator(".grid-tab", has_text="Z")).to_have_count(0)
    page.keyboard.press("Escape")

    # Quantity: ESP32 went 1 + 4 = 5; - three times, then x to 0.
    type_search(page, "esp32")
    page.keyboard.press("Escape")
    expect(rows(page).first.locator(".row-qty")).to_have_text("5")
    page.keyboard.press("-")
    page.keyboard.press("-")
    page.keyboard.press("-")
    expect(page.locator(".preview .qty-value")).to_have_text("2")
    # x types the quantity in place, in the details.
    page.keyboard.press("x")
    expect(page.locator(".preview .qty-edit")).to_be_focused()
    page.locator(".preview .qty-edit").fill("0")
    page.keyboard.press("Enter")
    expect(page.locator(".toast")).to_contain_text("added to the shopping list")
    expect(page.locator("#shopping-count")).to_have_text("1")
    page.keyboard.press("-")  # nothing below zero
    expect(page.locator(".preview .qty-value")).to_have_text("0")

    # Arduino: 2 → 0 with the − button.
    type_search(page, "nano")
    page.locator(".preview .qty-step").first.click()
    page.locator(".preview .qty-step").first.click()
    expect(page.locator("#shopping-count")).to_have_text("2")

    # The shopping list: search inside it, restock one, delete the other.
    page.keyboard.press("Escape")
    page.keyboard.press("Escape")
    azerty(page, '"')
    expect(page.locator("#tab-shopping")).to_have_class("tab active")
    # Only the two items whose quantity dropped to 0: the ones created at 0 stay off the list.
    expect(rows(page)).to_have_count(2)
    shot(page, "07a-shopping")
    type_search(page, "esp")
    expect(rows(page)).to_have_count(1)
    page.locator(".shopping-actions .button.primary").click()
    page.locator(".preview .qty-edit").fill("10")
    page.keyboard.press("Enter")
    expect(page.locator(".toast")).to_contain_text("restocked (10)")
    expect(rows(page)).to_have_count(0)
    type_search(page, "")
    page.keyboard.press("Escape")
    expect(rows(page)).to_have_count(1)
    page.keyboard.press("d")
    expect(page.locator(".toast")).to_contain_text("Deleted “Arduino Nano”")
    expect(page.locator("#shopping-count")).to_have_text("")  # nothing to buy: no count
    expect(page.locator(".empty-state")).to_contain_text("Nothing to buy")
    azerty(page, "&")
    expect(page.locator("#tab-parts")).to_have_class("tab active")

    # Bulk: select two items, tag them.
    type_search(page, "#capacitor")
    page.keyboard.press("Escape")
    page.keyboard.press(" ")
    page.keyboard.press(" ")
    expect(page.locator("#status-selection")).to_have_text("2 selected")
    page.keyboard.press("t")
    page.locator(".modal input").type("bench")
    page.keyboard.press("Enter")
    expect(page.locator(".toast")).to_contain_text("Tags updated on 2 items")
    type_search(page, "#bench")
    expect(rows(page)).to_have_count(2)

    # Tag manager: rename a parent tag renames its children.
    page.keyboard.press("Escape")
    page.keyboard.press("Escape")
    page.keyboard.press("T")
    expect(page.locator(".tag-row")).not_to_have_count(0)
    shot(page, "08-tags")
    page.keyboard.press("Escape")

    # Gear: a register of valuables, with files.
    page.keyboard.press("Escape")
    type_search(page, "")
    page.keyboard.press("Escape")
    azerty(page, "é")
    expect(page.locator("#tab-gear")).to_have_class("tab active")
    expect(page.locator(".empty-state")).to_contain_text("No gear yet")
    page.keyboard.press("a")
    form = page.locator(".item-modal")
    expect(form.locator(".modal-title")).to_have_text("New gear")
    form.locator("input").first.type("Perceuse visseuse")
    form.locator('input[aria-label="Type"]').fill("Power tool")
    form.locator('input[aria-label="Brand"]').fill("Makita")
    form.locator('input[aria-label="Reference"]').fill("DHP482")
    form.locator('input[aria-label="Serial number"]').fill("SN 4821-77")
    form.locator('input[aria-label="Warranty until"]').fill("2027-03-31")
    form.locator('input[aria-label="Tag"]').type("power")
    form.locator('input[aria-label="Tag"]').press("Enter")
    shot(page, "15-gear-add")
    form.locator(".modal-action").click()
    expect(form).to_have_count(0)
    expect(rows(page)).to_have_count(1)
    expect(rows(page).first).to_contain_text("SN 4821-77")
    # The warranty shows in the details only.
    expect(rows(page).first).not_to_contain_text("2027")
    expect(page.locator(".preview-title")).to_have_text("Perceuse visseuse")
    expect(page.locator(".preview .warranty")).to_contain_text("valid")

    # f opens the file picker; the invoice shows in the files with its label.
    with page.expect_file_chooser() as chooser:
        page.keyboard.press("f")
    chooser.value.set_files({"name": "Facture Makita.pdf", "mimeType": "application/pdf", "buffer": PDF})
    expect(page.locator(".toast")).to_contain_text("1 file attached")
    file_link = page.locator(".preview .file-name")
    expect(file_link).to_have_text("Facture Makita.pdf")
    expect(page.locator(".preview .file-label")).to_have_text("invoice")
    expect(rows(page).first.locator(".row-files")).to_have_text("1")

    # Dropping a file on the details attaches it too.
    page.evaluate("""() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['manual text'], 'notice DHP482.txt', { type: 'text/plain' }));
        const pane = document.getElementById('preview');
        for (const type of ['dragenter', 'dragover', 'drop']) {
          pane.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
        }
    }""")
    expect(page.locator(".preview .file-row")).to_have_count(2)
    expect(page.locator(".preview .file-label").nth(1)).to_have_text("manual")
    shot(page, "16-gear-files")

    # The signed link opens the file without the session (as iOS's viewer does).
    url = file_link.first.get_attribute("href")
    stranger = browser.new_context()
    res = stranger.request.get(f"{BASE}{url}")
    assert res.status == 200 and res.body() == PDF, res.status
    assert res.headers["content-type"] == "application/pdf"
    assert stranger.request.get(f"{BASE}{url.split('?')[0]}").status == 401
    stranger.close()

    # Found by serial, from any tab; parts point to the gear.
    azerty(page, "&")
    type_search(page, "makita")
    expect(page.locator(".empty-state")).to_contain_text("1 in gear")
    page.locator(".empty-state .link-button").click()
    expect(page.locator("#tab-gear")).to_have_class("tab active")
    type_search(page, "SN4821")
    expect(rows(page)).to_have_count(1)

    # Broken, lost, sold: archived. It leaves the list and stays recorded with its invoice.
    page.keyboard.press("Escape")
    page.keyboard.press("A")
    expect(page.locator(".toast")).to_contain_text("Archived “Perceuse visseuse”")
    expect(page.locator(".empty-state")).to_contain_text("1 archived")
    type_search(page, "")
    page.keyboard.press("Escape")
    expect(rows(page)).to_have_count(0)
    expect(page.locator(".list-note")).to_contain_text("1 archived item hidden")
    page.locator(".list-note .button").click()
    expect(page.locator(".archive-banner")).to_be_visible()
    expect(rows(page)).to_have_count(1)
    expect(page.locator(".preview .kicker")).to_contain_text("archived")
    shot(page, "16a-archive")
    type_search(page, "is:archived")
    expect(rows(page)).to_have_count(1)

    # Deleting the item and undoing keeps its files.
    page.keyboard.press("Escape")
    page.keyboard.press("d")
    expect(rows(page)).to_have_count(0)
    page.keyboard.press("u")
    expect(rows(page)).to_have_count(1)
    expect(page.locator(".preview .file-row")).to_have_count(2)

    # Restored: back with the gear in use.
    page.keyboard.press("A")
    expect(page.locator(".toast")).to_contain_text("Restored")
    type_search(page, "")
    page.keyboard.press("Escape")
    page.locator(".archive-banner .button").click()
    expect(rows(page)).to_have_count(1)

    # A watch: the type picks offer the one already used, and the list comes by type.
    page.keyboard.press("a")
    form = page.locator(".item-modal")
    expect(form.locator(".pick", has_text="power tool")).to_be_visible()
    form.locator("input").first.type("Seiko 5")
    form.locator('input[aria-label="Type"]').fill("watch")
    form.locator('input[aria-label="Brand"]').fill("Seiko")
    form.locator(".modal-action").click()
    expect(form).to_have_count(0)
    type_search(page, "")
    page.keyboard.press("Escape")
    expect(page.locator(".box-head")).to_have_count(2)
    expect(page.locator(".box-head").first).to_contain_text("power tool")
    expect(page.locator(".box-head").nth(1)).to_contain_text("watch")
    shot(page, "16b-gear-types")
    type_search(page, "watch")
    expect(rows(page)).to_have_count(1)
    expect(rows(page).first.locator(".row-type")).to_have_text("watch")
    type_search(page, "type:power")
    expect(rows(page)).to_have_count(1)
    expect(rows(page).first).to_contain_text("Perceuse visseuse")
    type_search(page, "")
    page.keyboard.press("Escape")
    azerty(page, "&")

    page.keyboard.press("?")
    shot(page, "09-help")
    page.keyboard.press("Escape")

    # Deep link.
    page.goto(f"{BASE}/?q=%23capacitor")
    expect(rows(page)).to_have_count(2)

    light = browser.new_context(viewport={"width": 1280, "height": 820}, color_scheme="light", storage_state=ctx.storage_state())
    lp = light.new_page()
    watch(lp)
    lp.goto(f"{BASE}/?q=esp")
    expect(rows(lp)).to_have_count(1)
    shot(lp, "10-light")
    light.close()
    state = ctx.storage_state()
    ctx.close()
    return state


def phone(browser, state):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                              color_scheme="dark", storage_state=state)
    page = ctx.new_page()
    watch(page)
    page.goto(BASE)
    expect(rows(page)).not_to_have_count(0)
    # iOS 26 blurs the top of the page unless an opaque sticky element touches it.
    assert page.locator(".masthead").evaluate("e => getComputedStyle(e).position") == "sticky"
    shot(page, "11-phone-list")

    # The details open full screen and follow every change: + tapped twice shows 12.
    type_search(page, "esp32")
    rows(page).first.tap()
    sheet = page.locator(".preview-sheet")
    expect(sheet).to_be_visible()
    box = sheet.bounding_box()
    assert box["y"] == 0 and box["height"] == 844, box
    expect(sheet.locator(".preview-title")).to_have_text("ESP32-WROOM")
    plus = sheet.locator(".qty-step").nth(1)
    expect(sheet.locator(".qty-value")).to_have_text("10")
    plus.tap()
    plus.tap()
    expect(sheet.locator(".qty-value")).to_have_text("12")
    sheet.locator(".qty-step").first.tap()
    expect(sheet.locator(".qty-value")).to_have_text("11")
    shot(page, "12-phone-preview")
    # Typing the quantity: the number turns into a field, in place.
    sheet.locator(".qty-value").tap()
    expect(sheet.locator(".qty-edit")).to_be_focused()
    sheet.locator(".qty-edit").fill("0")
    page.keyboard.press("Enter")
    expect(sheet.locator(".qty-note")).to_contain_text("On the shopping list")

    # Move on the map of the box: tap a free slot, then confirm.
    sheet.locator(".spec .button", has_text="Move").tap()
    page.locator(".map-cell.free").first.tap()
    page.locator(".map-confirm .button").tap()
    expect(page.locator(".toast")).to_contain_text("Moved “ESP32-WROOM” to B-1")
    expect(sheet.locator(".ds-sub")).to_contain_text("B-1")
    sheet.locator(".modal-close").tap()
    expect(page.locator(".preview-sheet")).to_have_count(0)

    # Adding: the same form as on a computer, with a box map to tap.
    type_search(page, "")
    page.locator("#tab-add").tap()
    form = page.locator(".item-modal")
    name = form.locator("input").first
    expect(name).to_be_focused()
    name.type("ESP32 clone")
    expect(form.locator(".look-alike").first).to_contain_text("ESP32-WROOM")
    shot(page, "13-phone-add")
    name.fill("Câble dupont")
    form.locator(".map-box", has_text="Box B").tap()
    form.locator('.map-cell[aria-label^="B-2:"]').tap()
    expect(form.locator(".chip-slot")).to_have_count(1)
    expect(form.locator(".chip-slot")).to_contain_text("B-2")
    form.locator(".stepper button").nth(1).tap()
    form.locator(".modal-action").tap()
    sheet = page.locator(".preview-sheet")
    expect(sheet.locator(".preview-title")).to_have_text("Câble dupont")
    expect(sheet.locator(".qty-value")).to_have_text("2")
    expect(sheet.locator(".ds-sub")).to_contain_text("B-2")
    # Edit opens the same form, filled in.
    sheet.locator(".modal-action").tap()
    expect(page.locator(".item-modal .modal-title")).to_have_text("Edit part")
    expect(page.locator(".item-modal .chip-slot")).to_contain_text("B-2")
    shot(page, "13a-phone-edit")
    page.locator(".item-modal .modal-close").tap()
    sheet.locator(".modal-close").tap()

    # Box grid by touch: tap A-11, "swap", then tap A-14.
    page.locator("#more-button").tap()
    page.locator(".menu-item", has_text="Boxes").tap()
    page.locator(".grid-tab", has_text="A").tap()
    page.locator(".grid .cell").nth(10).tap()
    page.locator(".grid-actions .button.primary").tap()
    expect(page.locator(".grid-hint")).to_contain_text("swap A-11 with")
    page.locator(".grid .cell").nth(13).tap()
    expect(page.locator(".toast")).to_contain_text("Swapped A-11 and A-14")
    expect(page.locator(".grid .cell").nth(13)).to_contain_text("Résistance 10k")
    shot(page, "14-phone-grid")

    # Gear on the phone: the sheet takes a file from the picker and shows it at once.
    page.locator(".modal-close").last.tap()
    page.locator("#tab-gear").tap()
    rows(page).filter(has_text="Perceuse").tap()
    sheet = page.locator(".preview-sheet")
    expect(sheet.locator(".file-row")).to_have_count(2)
    with page.expect_file_chooser() as chooser:
        sheet.locator(".drop-zone").tap()
    chooser.value.set_files({"name": "photo.jpg", "mimeType": "image/jpeg", "buffer": b"\xff\xd8\xff\xe0" + b"0" * 64})
    expect(sheet.locator(".file-row")).to_have_count(3)
    expect(sheet.locator(".file-label").nth(2)).to_have_text("photo")
    shot(page, "17-phone-gear")
    ctx.close()


with sync_playwright() as p:
    browser = p.chromium.launch()
    try:
        state = desktop(browser)
        try:
            phone(browser, state)
        except Exception:
            for ctx in browser.contexts:
                for pg in ctx.pages:
                    pg.screenshot(path=f"{OUT}/failure.png")
            raise
    finally:
        browser.close()

if errors:
    print("\n".join(errors))
    sys.exit(1)
print("e2e ok")
