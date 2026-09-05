/**
 * Make a whole table row navigate, without breaking the things a row full of
 * text needs to keep doing.
 *
 * A row that highlights on hover reads as clickable, so when only a small
 * "View" link navigates, most of the target is dead. Putting a bare onClick on
 * the row fixes that and breaks three other things, which is why this helper
 * exists rather than an inline handler:
 *
 * - Selecting text by dragging across the row ends in a navigation, so the
 *   figures in the row cannot be copied.
 * - Cmd, Ctrl, Shift and middle clicks navigate in place instead of opening a
 *   new tab or window, which is what those gestures mean everywhere else.
 * - A click on a control inside the row navigates as well as acting, so a
 *   button in a cell does two things at once.
 *
 * KEYBOARD AND ASSISTIVE TECH ARE NOT SERVED BY THIS. A row is not focusable
 * and this adds no role, because announcing a whole row as a link would bury
 * the cells it contains. Every row using this MUST still contain a real anchor
 * (the primary cell's link), which is what keyboard users, screen readers, and
 * "copy link address" actually use. This handler is a mouse convenience layered
 * on top of that link, never a replacement for it.
 */
const INTERACTIVE = 'a, button, input, select, textarea, label, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"]'

export function shouldNavigateFromRowClick(event: {
  target: EventTarget | null
  defaultPrevented: boolean
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  if (event.defaultPrevented) return false
  // Primary button only. Auxiliary and secondary clicks have their own meaning.
  if (event.button !== 0) return false
  // Let the browser's own new-tab / new-window / download gestures through to
  // the real link rather than swallowing them into a same-tab navigation.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false

  const target = event.target
  if (target && typeof (target as Element).closest === 'function') {
    // A control inside the row already handled this click.
    if ((target as Element).closest(INTERACTIVE)) return false
  }

  // A drag that selected text is a copy gesture, not a click-through.
  const selection = typeof window !== 'undefined' ? window.getSelection() : null
  if (selection && !selection.isCollapsed && selection.toString().trim() !== '') return false

  return true
}
