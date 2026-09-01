# Lessons

## 2026-08-28 — Note pointer intent

- User correction: a normal click on a Note must edit immediately. Holding the same click and moving must drag either a Note or Board Portal.
- Implementation consequence: distinguish click from drag with a movement threshold instead of requiring double click or a permanent drag handle.
- While a Note is already editing, text gestures select text and the outer frame remains the move surface.

## 2026-09-01 — Product north star and future agent surface

- User correction: the product is primarily a personal visual filesystem inspired by Milanote, not a conventional note editor with a canvas added on top.
- V1 must prioritize spatial recognition, free placement, and Boards inside Boards; visual fidelity and the direct-manipulation interaction model are product requirements, not optional polish.
- Future filesystem shortcuts should visually project linked Mac folders and their contents without copying the underlying files into the workspace.
- A future in-app agent chat may accept text, links, and images, then create, place, group, or reorganize workspace information through the same typed domain commands used by the UI.
- The agent provider is intentionally undecided (a terminal agent or Hermes-like installation are candidates). Provider-specific APIs must not enter the V1 board/card domain model.
- This agent surface is a future control plane over the visual workspace, not part of V1 and not the product's primary navigation model.

## 2026-09-01 — ID generation stays on the frontend

- Decision (review follow-up): keep card/board IDs as an input to `create_*` commands rather than returning backend-generated IDs.
- Rationale: the plan requires stable IDs before persistence; optimistic UI needs them upfront; a lost backend response can be safely replayed with the same ID; Board + Portal creation needs both IDs known in advance.
- Therefore replace native `crypto.randomUUID()` (UUIDv4) with a centralized frontend `IdGenerator` producing UUIDv7, injectable and deterministic in tests.
- Backend must still validate UUID shape and reject conflicting reuse of an existing ID.
