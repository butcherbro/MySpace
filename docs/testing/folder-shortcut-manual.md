# Folder Shortcut — packaged macOS acceptance

Run `npm run tauri dev` (or a packaged `.app`) and verify by hand:

## Drop

1. Drag a real macOS folder from Finder onto a board.
2. A blue folder card appears; it shows the folder name, the path hint, and a
   shallow list of top-level files/subfolders (folders first, case-insensitive).
3. Dragging a file of an image type keeps the existing Image Card path; an
   unsupported file creates nothing.

## Bookmark durability

4. Restart the packaged app: the folder resolves again and lists current names.
5. Rename or move the folder: macOS bookmark resolution updates the identity
   (path hint/name refresh); a truly missing folder shows an explicit missing
   state and the card is never silently deleted.
6. Revoke access (e.g. move the folder to a location the app cannot read): the
   card shows a permission-lost state, stays movable.

## Interaction

7. The top-right Finder action opens the linked folder in Finder.
8. Resize via the bottom-right handle: reducing height keeps the blue folder
   silhouette and shows fewer rows; increasing height reveals more rows from the
   bounded preview. Never refetch on every pointer move.
9. Delete from the context menu → appears in Trash; restore brings it back with
   its bookmark detail intact.
10. Search finds it by display name and path hint; selecting the result
    navigates to and selects the card.

## Out of scope (not expected to work)

File/document cards, Option-drop aliases, opening child folders in place,
recursive listing, watchers, document previews, and App Sandbox.
