# Close-flush — packaged macOS acceptance

The unit tests in `src/app/use-close-flush.test.ts` cover the coordinator with
substituted queues; they cannot cover the real window close. A plain browser
cannot delay its own close, so this path is only real in the packaged app. Run
`npm run tauri dev` (or a packaged `.app`) and verify by hand:

## The last edit survives

1. Open a note, type a word, and press `Cmd+Q` (or the red close button) within
   about a quarter of a second — inside the 250 ms autosave debounce.
2. Reopen the app and open the same board: the word is there.
3. Repeat for an image caption, and for a note whose text was finalized by
   pressing `Enter` (a URL-only note converting to a Link Card).
4. Zoom the canvas, then close within the debounce: reopening the board shows the
   zoomed viewport, not the previous one.
5. Close while a drag is settling (release a card and close immediately): the
   card keeps its new position.

## Failure behaviour

6. Make writes fail (e.g. make the workspace database read-only) and close: the
   app asks "Your last changes could not be saved. Close without saving?" with
   `Stay` and `Close without saving`.
7. `Stay` keeps the window open and shows the error banner; `Close without
   saving` closes the app.
8. Press `Cmd+Q` twice while the first close is still waiting: the second press
   closes without asking — insisting must never trap the user in the window.

## Nothing is intercepted when it should not be

9. A close with nothing pending is immediate: no visible delay, no dialog.
10. `open` a plain browser session (`npm run dev`) and close the tab: no dialog,
    no console errors — a browser session still flushes best-effort on `pagehide`.

## Known limits

- The `pagehide` path in a browser is fire-and-forget: an unload cannot be
  awaited, so it reduces loss but does not guarantee it.
- `destroy` needs `core:window:allow-destroy` in `src-tauri/capabilities/default.json`.
  If a future edit drops it, a close stops working instead of degrading: this
  checklist is what catches that.
