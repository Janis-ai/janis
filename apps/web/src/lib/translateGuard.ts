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
  const proto = Node.prototype as unknown as {
    __janisTranslateGuard?: boolean;
    insertBefore: (newNode: Node, refNode: Node | null) => Node;
    removeChild: (child: Node) => Node;
  };
  if (proto.__janisTranslateGuard) return;
  proto.__janisTranslateGuard = true;
  const insertBefore = proto.insertBefore;
  const removeChild = proto.removeChild;
  proto.insertBefore = function (this: Node, newNode: Node, refNode: Node | null): Node {
    if (refNode && (refNode.parentNode as unknown) !== this) return newNode;
    return insertBefore.call(this, newNode, refNode);
  };
  proto.removeChild = function (this: Node, child: Node): Node {
    if ((child.parentNode as unknown) !== this) return child;
    return removeChild.call(this, child);
  };
}
