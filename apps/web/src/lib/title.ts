import { useEffect } from 'react';
import { refreshTabBadge } from './tabBadge';

/** Sets the bare document title for the current page, then re-applies the
 *  unread-count badge so "(3) Contacts — Janis" survives navigation. */
export function usePageTitle(name: string | null | undefined) {
  useEffect(() => {
    document.title = name ? `${name} — Janis` : 'Janis';
    refreshTabBadge();
  }, [name]);
}
