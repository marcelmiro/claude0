/**
 * Space menu — neovim which-key style action overlay.
 * Renders a popup at bottom-left of the session list with contextual actions.
 */

import { C } from "./colors";
import { handleTextInputKey, renderTextWithCursor } from "./text-input";

export type SpaceMenuLevel = "root" | "send-message";

export interface SpaceMenuState {
  level: SpaceMenuLevel;
  /** Back target when exiting an input level */
  previousLevel?: SpaceMenuLevel;
  /** Text input state for send-message */
  messageText: string;
  messageCursor: number;
  /**
   * Whether the send-message action is offered (Inc5). Free-text send is only
   * safe when the session is at a prompt — `ready` or `waiting` (waiting-input).
   * Otherwise the item is hidden and `m` is inert (no keystrokes reach the pane).
   */
  canSendMessage: boolean;
}

export type SpaceMenuAction =
  | { type: "noop" }
  | { type: "render" }
  | { type: "close" }
  | { type: "back" }
  | { type: "exec"; command: "copy" | "rename" | "kill" | "fork" }
  | { type: "send-keys"; keys: string[] }
  | { type: "send-text"; text: string }
  | { type: "start-input" };

// --- State lifecycle ---

export function createSpaceMenuState(canSendMessage = true): SpaceMenuState {
  return {
    level: "root",
    messageText: "",
    messageCursor: 0,
    canSendMessage,
  };
}

// --- Rendering ---

function keyLabel(key: string, label: string): string {
  return `  {${C.peach}-fg}${key}{/${C.peach}-fg}  ${label}`;
}

function renderRoot(canSendMessage: boolean): string {
  const lines = [
    keyLabel("c", "copy"),
    keyLabel("r", "rename"),
    keyLabel("x", "kill"),
    keyLabel("f", "fork"),
  ];
  // Send-message only when the session is at a prompt (Inc5).
  if (canSendMessage) lines.unshift(keyLabel("m", "send message"));
  return lines.join("\n");
}

function renderTextLevel(title: string, hint: string, text: string, cursor: number): string {
  return [
    ` {bold}${title}{/bold}`,
    "",
    ` {${C.peach}-fg}\u276f{/${C.peach}-fg} ${renderTextWithCursor(text, cursor)}`,
    "",
    `  {${C.dim}-fg}${hint}{/${C.dim}-fg}`,
  ].join("\n");
}

export function renderSpaceMenu(state: SpaceMenuState): string {
  switch (state.level) {
    case "root":
      return renderRoot(state.canSendMessage);
    case "send-message":
      return renderTextLevel("Send message", "Enter send \u00b7 Esc back", state.messageText, state.messageCursor);
  }
}

// --- Dimensions ---

export function getMenuDimensions(state: SpaceMenuState): { width: number; height: number } {
  switch (state.level) {
    case "root":
      // +1 when send-message is offered.
      return { width: 24, height: state.canSendMessage ? 7 : 6 };
    case "send-message":
      return { width: 42, height: 7 };
  }
}

// --- Key handling ---

export function handleSpaceMenuKey(
  state: SpaceMenuState,
  keyName: string,
  ch: string,
): SpaceMenuAction {
  switch (state.level) {
    case "root":
      return handleRootKey(state, keyName, ch);
    case "send-message":
      return handleTextLevelKey(state, keyName, ch, (text) => ({ type: "send-text", text }));
  }
}

function handleRootKey(state: SpaceMenuState, _keyName: string, ch: string): SpaceMenuAction {
  switch (ch) {
    case "m": return state.canSendMessage ? { type: "start-input" } : { type: "noop" };
    case "c": return { type: "exec", command: "copy" };
    case "r": return { type: "exec", command: "rename" };
    case "x": return { type: "exec", command: "kill" };
    case "f": return { type: "exec", command: "fork" };
    default: return { type: "close" };
  }
}

function handleTextLevelKey(
  state: SpaceMenuState,
  keyName: string,
  ch: string,
  onSubmit: (text: string) => SpaceMenuAction,
): SpaceMenuAction {
  if (keyName === "escape") return { type: "back" };

  if (keyName === "enter" || keyName === "return") {
    if (state.messageText.trim()) return onSubmit(state.messageText);
    return { type: "noop" };
  }

  // Delegate to text input handler
  const result = handleTextInputKey(state.messageText, state.messageCursor, keyName, ch);
  if (result.handled) {
    state.messageText = result.text;
    state.messageCursor = result.cursor;
    return { type: "render" };
  }

  return { type: "noop" };
}
