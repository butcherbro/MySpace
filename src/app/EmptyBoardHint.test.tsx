import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyBoardHint } from "./EmptyBoardHint";
import type { CardDto } from "../services/workspace-gateway";

// Заготовка минимальной карточки: для проверки условия показа подсказки
// важен только `kind`, остальные поля не влияют на рендер.
function card(kind: CardDto["kind"]): CardDto {
  return { kind } as CardDto;
}

describe("EmptyBoardHint", () => {
  it("shows the hint when the board has no cards at all", () => {
    render(<EmptyBoardHint cards={[]} error={null} />);
    expect(screen.getByText("Click “New note” to create your first note.")).toBeInTheDocument();
  });

  it("hides the hint once a text note exists", () => {
    render(<EmptyBoardHint cards={[card("note")]} error={null} />);
    expect(screen.queryByText(/Click/)).not.toBeInTheDocument();
  });

  // Баг: раньше условие показа смотрело только на заметки (kind === "note"),
  // поэтому доска с одной картинкой/ссылкой/файлом/порталом/папкой всё ещё
  // считалась "пустой" и подсказка продолжала висеть поверх карточек.
  it("hides the hint when the board only has an image card", () => {
    render(<EmptyBoardHint cards={[card("image")]} error={null} />);
    expect(screen.queryByText(/Click/)).not.toBeInTheDocument();
  });

  it("hides the hint when the board only has a link/embed card", () => {
    render(<EmptyBoardHint cards={[card("embed")]} error={null} />);
    expect(screen.queryByText(/Click/)).not.toBeInTheDocument();
  });

  it("hides the hint when the board only has a file card", () => {
    render(<EmptyBoardHint cards={[card("file")]} error={null} />);
    expect(screen.queryByText(/Click/)).not.toBeInTheDocument();
  });

  it("hides the hint when the board only has a board portal", () => {
    render(<EmptyBoardHint cards={[card("board_portal")]} error={null} />);
    expect(screen.queryByText(/Click/)).not.toBeInTheDocument();
  });

  it("hides the hint when the board only has a filesystem alias (folder)", () => {
    render(<EmptyBoardHint cards={[card("filesystem_alias")]} error={null} />);
    expect(screen.queryByText(/Click/)).not.toBeInTheDocument();
  });

  it("hides the hint when there is an error banner, even on an empty board", () => {
    render(<EmptyBoardHint cards={[]} error="boom" />);
    expect(screen.queryByText(/Click/)).not.toBeInTheDocument();
  });

  it("does not intercept pointer events (sits below the card layer)", () => {
    render(<EmptyBoardHint cards={[]} error={null} />);
    const hint = screen.getByText("Click “New note” to create your first note.");
    expect(hint).toHaveClass("workspace__empty");
  });
});
