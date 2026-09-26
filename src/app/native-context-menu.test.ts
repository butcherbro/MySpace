import { describe, expect, it } from "vitest";
import { installNativeContextMenuGuard, isEditableTarget } from "./native-context-menu";

describe("native context menu guard", () => {
  it("treats inputs, textareas and contenteditable as editable, buttons and the canvas as not", () => {
    document.body.innerHTML = `
      <input id="text" type="text" />
      <input id="check" type="checkbox" />
      <textarea id="area"></textarea>
      <div id="editor" contenteditable="true"><p id="inside">x</p></div>
      <div id="locked" contenteditable="false"></div>
      <button id="btn">b</button>
      <div id="pane"></div>`;
    const q = (id: string) => document.getElementById(id);
    expect(isEditableTarget(q("text"))).toBe(true);
    expect(isEditableTarget(q("area"))).toBe(true);
    expect(isEditableTarget(q("inside"))).toBe(true);
    expect(isEditableTarget(q("check"))).toBe(false);
    expect(isEditableTarget(q("locked"))).toBe(false);
    expect(isEditableTarget(q("btn"))).toBe(false);
    expect(isEditableTarget(q("pane"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("prevents the default menu on the pane but not inside an editor", () => {
    document.body.innerHTML = `<div id="pane"></div><div id="editor" contenteditable="true"></div>`;
    const dispose = installNativeContextMenuGuard(document);
    const fire = (id: string) => {
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.getElementById(id)!.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(fire("pane")).toBe(true);
    expect(fire("editor")).toBe(false);
    dispose();
    expect(fire("pane")).toBe(false);
  });
});
