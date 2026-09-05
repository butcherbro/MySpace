import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoteEditor } from "./NoteEditor";

// If a note document already carries a `link` mark (e.g. saved as clickable
// text), the display-mode editor must render it as an actual `<a href>` so the
// user can see and click it.
describe("NoteEditor link rendering", () => {
  it("renders a link mark as an <a> anchor in display mode", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "open https://example.com now",
              marks: [
                { type: "link", attrs: { href: "https://example.com" } },
              ],
            },
          ],
        },
      ],
    };

    const { container } = render(
      <NoteEditor document={doc} editable={false} onChange={() => {}} />,
    );

    const anchors = container.querySelectorAll("a");
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors[0].getAttribute("href")).toBe("https://example.com");
  });
});
