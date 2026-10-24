/**
 * Google Translate rewrites text nodes in place (wrapping them in <font>
 * tags), which leaves React's reconciliation pointing at detached nodes —
 * every insertBefore/removeChild then throws "node is not a child" and the
 * error boundary eats the whole page (prod error reports 2026-10-24,
 * /welcome?rail=ask on a Vietnamese-translated session). The React team's
 * documented workaround: tolerate mutations that moved the node GT touched
 * rather than crashing on them. Install before the first render.
 */
export function installTranslateGuard() {
  if (typeof Node !== 'function' || !Node.prototype) return;
  const proto = Node.prototype as unknown as Record<string, unknown> & {
    insertBefore: Node['insertBefore'];
    removeChild: Node['removeChild'];
  };
  if (proto.__janisTranslateGuard) return;
  proto.__janisTranslateGuard = true;
  const insertBefore = proto.insertBefore;
  proto.insertBefore = function <T extends Node>(newNode: T, refNode: Node | null): T {
    if (refNode && refNode.parentNode !== this) return newNode;
    return insertBefore.call(this, newNode, refNode);
  };
  const removeChild = proto.removeChild;
  proto.removeChild = function <T extends Node>(child: T): T {
    if (child.parentNode !== this) return child;
    return removeChild.call(this, child);
  };
}
