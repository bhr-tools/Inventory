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

    # Quick Add warns about look-alikes and adds to the existing item.
    page.keyboard.press("Escape")
    page.keyboard.press("a")
    qa = page.locator(".quick-input")
    expect(qa).to_be_focused()
    # The guide shows the syntax of every field, and highlights the one being typed.
    guide = page.locator(".quick-guide")
    expect(guide.locator(".guide-row.typing .guide-label")).to_have_text("name")
    expect(guide).to_contain_text("x5")
    qa.type("Fil de cuivre #ele")
    expect(guide.locator(".guide-row.typing .guide-label")).to_have_text("tags")
    qa.type("ctronic x3")
    expect(guide.locator(".guide-row.typing .guide-label")).to_have_text("qty")
    expect(guide.locator(".chip.quantity")).to_have_text("3")
    expect(guide.locator(".guide-row.filled")).to_have_count(3)
    shot(page, "04a-quickadd-guide")
    qa.fill("")
    qa.type("Condensateur ceramic 100 nF B-9")
    expect(page.locator(".quick-suggestions .complete-item").first).to_contain_text("Condensateur céramique 100nF")
    shot(page, "04-quickadd-similar")
    qa.press("ArrowDown")
    qa.press("Enter")
    expect(page.locator(".toast")).to_contain_text("Updated “Condensateur céramique 100nF”")
    expect(qa).to_have_value("")

    # The exact same name (case and accents aside) merges without asking.
    qa.type("esp32-wroom C-9 x4")
    expect(page.locator(".quick-notice")).to_contain_text("4 more")
    qa.press("Enter")
    expect(page.locator(".toast")).to_contain_text("now in B-2, C-9")

    # Slot and tag completion.
    qa.type("Multimètre a-")
    expect(page.locator(".quick-suggestions .complete-title")).to_have_text("Slots")
    expect(page.locator(".quick-suggestions .complete-item").first).to_contain_text("A-1")
    expect(page.locator(".quick-suggestions .complete-item").first).to_contain_text("empty")
    qa.press("Tab")
    qa.type("#to")
    expect(page.locator(".quick-suggestions .complete-item").first).to_contain_text("#tool")
    shot(page, "05-quickadd-tags")
    qa.press("Tab")
    expect(qa).to_have_value("Multimètre A-1 #tool ")
    qa.press("Enter")
    expect(page.locator(".toast")).to_contain_text("Added “Multimètre” to A-1")
    page.keyboard.press("Escape")

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

    # Move with completion.
    page.keyboard.press("m")
    page.locator(".modal input").fill("a-5")
    expect(page.locator(".field-info")).to_contain_text("A-5: empty")
    page.keyboard.press("Enter")
    expect(rows(page).first).to_contain_text("A-5")

    # Editor.
    page.keyboard.press("e")
    expect(page.locator(".editor-modal")).to_be_visible()
    name = page.locator(".editor input").first
    name.fill("Pince coupante")
    expect(page.locator(".field-warning")).to_contain_text("Another item already has this name")
    name.fill("Multimètre Fluke")
    page.locator(".editor textarea").nth(1).fill("Fuse: 440 mA")
    shot(page, "06-editor")
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
    expect(page.locator(".grid-hint")).to_contain_text("Swap A-5 with")
    shot(page, "07-grid")
    page.keyboard.press("s")
    expect(page.locator(".toast")).to_contain_text("Swapped A-5 and A-6")
    expect(page.locator(".grid .cell").nth(5)).to_contain_text("Multimètre Fluke")
    page.keyboard.press("]")
    expect(page.locator(".grid-tab.active")).to_have_text("B")
    page.keyboard.press("Escape")

    # Quantity: ESP32 went 1 + 4 = 5; - three times, then x to 0.
    type_search(page, "esp32")
    page.keyboard.press("Escape")
    expect(rows(page).first.locator(".row-qty")).to_have_text("5")
    page.keyboard.press("-")
    page.keyboard.press("-")
    page.keyboard.press("-")
    expect(page.locator(".preview .qty-value")).to_have_text("2")
    page.keyboard.press("x")
    page.locator(".qty-input").fill("0")
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
    azerty(page, "é")
    expect(page.locator("#tab-shopping")).to_have_class("tab active")
    # Only the two items whose quantity dropped to 0: the ones created at 0 stay off the list.
    expect(rows(page)).to_have_count(2)
    shot(page, "07a-shopping")
    type_search(page, "esp")
    expect(rows(page)).to_have_count(1)
    page.locator(".shopping-actions .button.primary").click()
    page.locator(".qty-input").fill("10")
    page.keyboard.press("Enter")
    expect(page.locator(".toast")).to_contain_text("restocked (10)")
    expect(rows(page)).to_have_count(0)
    type_search(page, "")
    page.keyboard.press("Escape")
    expect(rows(page)).to_have_count(1)
    page.keyboard.press("d")
    expect(page.locator(".toast")).to_contain_text("Deleted “Arduino Nano”")
    expect(page.locator("#shopping-count")).to_have_text("0")
    expect(page.locator(".empty-state")).to_contain_text("nothing to buy")
    azerty(page, "&")
    expect(page.locator("#tab-inventory")).to_have_class("tab active")

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
    shot(page, "11-phone-list")
    rows(page).first.tap()
    expect(page.locator(".preview-sheet")).to_be_visible()
    shot(page, "12-phone-preview")
    page.locator(".modal-overlay").click(position={"x": 10, "y": 10})
    page.locator("#fab").tap()
    page.locator(".quick-input").type("ESP32 clone")
    expect(page.locator(".quick-suggestions .complete-item").first).to_contain_text("ESP32-WROOM")
    shot(page, "13-phone-quickadd")
    ctx.close()


with sync_playwright() as p:
    browser = p.chromium.launch()
    try:
        state = desktop(browser)
        phone(browser, state)
    finally:
        browser.close()

if errors:
    print("\n".join(errors))
    sys.exit(1)
print("e2e ok")
