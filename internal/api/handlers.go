package api

import (
	"net/http"

	"github.com/ben/inventory/internal/db"
)

// inventory returns everything: the web app searches on its own copy, which
// keeps every keystroke instant.
func (a *API) inventory(w http.ResponseWriter, r *http.Request) {
	items, err := a.store.Items()
	if err != nil {
		fail(w, r, err)
		return
	}
	boxes, err := a.store.Boxes()
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "boxes": boxes})
}

func (a *API) createItem(w http.ResponseWriter, r *http.Request) {
	var in db.ItemInput
	if !decode(w, r, &in) {
		return
	}
	item, err := a.store.CreateItem(in)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (a *API) getItem(w http.ResponseWriter, r *http.Request) {
	item, err := a.store.Item(r.PathValue("id"))
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) updateItem(w http.ResponseWriter, r *http.Request) {
	var in db.ItemInput
	if !decode(w, r, &in) {
		return
	}
	item, err := a.store.UpdateItem(r.PathValue("id"), in)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

type idsRequest struct {
	IDs    []string `json:"ids"`
	Slot   string   `json:"slot"`
	Add    []string `json:"add"`
	Remove []string `json:"remove"`
}

// deleteItems answers with the removed items, which /restore takes back.
func (a *API) deleteItems(w http.ResponseWriter, r *http.Request) {
	var req idsRequest
	if !decode(w, r, &req) {
		return
	}
	removed, err := a.store.DeleteItems(req.IDs)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": removed})
}

func (a *API) restoreItems(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Items []db.Item `json:"items"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := a.store.RestoreItems(req.Items); err != nil {
		fail(w, r, err)
		return
	}
	a.inventory(w, r)
}

func (a *API) moveItems(w http.ResponseWriter, r *http.Request) {
	var req idsRequest
	if !decode(w, r, &req) {
		return
	}
	if err := a.store.MoveItems(req.IDs, req.Slot); err != nil {
		fail(w, r, err)
		return
	}
	a.inventory(w, r)
}

func (a *API) tagItems(w http.ResponseWriter, r *http.Request) {
	var req idsRequest
	if !decode(w, r, &req) {
		return
	}
	if err := a.store.TagItems(req.IDs, req.Add, req.Remove); err != nil {
		fail(w, r, err)
		return
	}
	a.inventory(w, r)
}

func (a *API) swapSlots(w http.ResponseWriter, r *http.Request) {
	var req struct {
		A string `json:"a"`
		B string `json:"b"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := a.store.SwapSlots(req.A, req.B); err != nil {
		fail(w, r, err)
		return
	}
	a.inventory(w, r)
}

func (a *API) renameTag(w http.ResponseWriter, r *http.Request) {
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := a.store.RenameTag(req.From, req.To); err != nil {
		fail(w, r, err)
		return
	}
	a.inventory(w, r)
}

func (a *API) deleteTag(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Tag string `json:"tag"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := a.store.DeleteTag(req.Tag); err != nil {
		fail(w, r, err)
		return
	}
	a.inventory(w, r)
}

func (a *API) setBox(w http.ResponseWriter, r *http.Request) {
	var b db.Box
	if !decode(w, r, &b) {
		return
	}
	b.ID = r.PathValue("id")
	if _, err := a.store.SetBox(b); err != nil {
		fail(w, r, err)
		return
	}
	a.inventory(w, r)
}

func (a *API) deleteBox(w http.ResponseWriter, r *http.Request) {
	if err := a.store.DeleteBox(r.PathValue("id")); err != nil {
		fail(w, r, err)
		return
	}
	a.inventory(w, r)
}

// changeQuantity takes {"delta": -1} or {"set": 12}.
func (a *API) changeQuantity(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Delta int  `json:"delta"`
		Set   *int `json:"set"`
	}
	if !decode(w, r, &req) {
		return
	}
	item, err := a.store.ChangeQuantity(r.PathValue("id"), req.Delta, req.Set)
	if err != nil {
		fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}
