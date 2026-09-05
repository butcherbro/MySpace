# Todo

## Current V1 delta — 2026-09-05

- [x] Add real Link Card metadata enrichment with bounded HTTP, YouTube/Open Graph support, and persisted fallback states.
- [x] Cache preview and favicon files as managed assets.
- [x] Auto-grow enriched Link Cards so preview, title, and description are visible without manual resize.
- [ ] Add empty-canvas double-click Note creation at the board-space cursor position.
- [ ] Fix breadcrumb projection to `Home / … / Current Board` and make every crumb navigable.
- [ ] Add atomic, undoable Board reparenting by dropping Board Portals onto Board Portals or breadcrumb ancestors.
- [ ] Let Note, Image, and Link Cards move to breadcrumb ancestors through the existing leaf-card command.
- [ ] Verify clean live Link Card auto-fit and YouTube channel Retry outside hot reload.
- [ ] Add explicit clipboard replacement for Link previews and Board Portal covers.
- [ ] Implement asset garbage collection for permanently deleted cards.
- [ ] Continue the Milanote-like left rail, top navigation, contextual formatting, and Search from `docs/plans/2026-09-04-spatial-workspace-interface.md`.
