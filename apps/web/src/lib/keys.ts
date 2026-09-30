/** True when a keydown target is an editable surface — plain-letter hotkeys
 *  must not fire while the user is typing. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)
  );
}
