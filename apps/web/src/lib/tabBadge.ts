/**
 * Tab-strip unread signal: "(n)" title prefix + red dot painted over the
 * favicon. Same-origin favicon → canvas is safe; a tainted/absent icon
 * silently skips and the title prefix still carries the signal.
 */
let origHref: string | null = null;
let badgeData: string | null = null;
let applied = false;
let lastCount = 0;

/** Re-applies the remembered unread count — call after something else sets
 *  document.title (e.g. per-page titles) so the count survives. */
export function refreshTabBadge() {
  setTabBadge(lastCount);
}

export function setTabBadge(count: number) {
  const n = count > 0 ? count : 0;
  lastCount = n;
  const bare = document.title.replace(/^\(\d+\+?\)\s+/, '');
  document.title = n > 0 ? `(${n > 99 ? '99+' : n}) ${bare}` : bare;

  const link = document.querySelector<HTMLLinkElement>(
    'link[rel~="icon"],link[rel="shortcut icon"]',
  );
  if (!link) return;
  if (origHref === null) origHref = link.getAttribute('href') ?? '';
  if (!n) {
    if (applied) {
      link.setAttribute('href', origHref);
      applied = false;
    }
    return;
  }
  if (badgeData) {
    link.setAttribute('href', badgeData);
    applied = true;
    return;
  }
  const img = new Image();
  img.onload = () => {
    const s = img.width || 32;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const x = c.getContext('2d');
    if (!x) return;
    x.drawImage(img, 0, 0, s, s);
    const r = s * 0.3;
    x.beginPath();
    x.arc(s - r * 0.7, r * 0.7, r, 0, Math.PI * 2);
    x.fillStyle = '#ef4444';
    x.fill();
    x.lineWidth = s * 0.1;
    x.strokeStyle = '#fff';
    x.stroke();
    try {
      badgeData = c.toDataURL('image/png');
    } catch {
      return;
    }
    link.setAttribute('href', badgeData);
    applied = true;
  };
  img.src = origHref;
}
