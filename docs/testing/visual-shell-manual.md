# Quiet Desk visual shell — manual checklist

Run `npm run tauri dev`, then verify by eye (no screenshot pixel diff in CI yet):

1. **Chrome recedes**: the top bar and left rail read as one quiet L-frame; the canvas
   starts below/right of it and never scrolls the chrome.
2. **No creation controls above the canvas**: Note/Link/Board/Image live only in the rail.
3. **Home is the first clickable breadcrumb**; the current Board is the last crumb.
4. **Object classes stay distinguishable** at a glance: Notes read as paper, Images as
   unframed media, Links as previews, Portals as colored/covered doorways.
5. **Default React Flow chrome is absent**: selection ring uses the focus token, the
   attribution is muted, node borders are transparent.
6. **Dense board stays scannable**: with `?fixture=dense` (or many objects on Home), zoom
   to 1 and 0.75 and confirm nothing merges into a blur.
7. **Context menus clamp** to the viewport when opened near the right/bottom edge.
8. **Retina** text and the dot grid remain crisp (no subpixel dots).
9. **Craft checks**: no gradients, bubbly cards, emoji icons, or decorative blobs; no new
   raw palette values in component CSS — only design tokens.
