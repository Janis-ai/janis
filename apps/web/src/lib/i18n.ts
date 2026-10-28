/**
 * Tiny i18n — browser-language UI strings for the first-minutes surface.
 * English is the source of truth at every call site: t('nav.inbox', 'Inbox').
 * Non-EN locales override by key; anything missing falls through to the
 * English literal, so coverage can grow incrementally. Locale is detected
 * once at load (navigator.language) — no provider, no re-render machinery.
 */
import { vi } from './i18n/vi';
import { es } from './i18n/es';
import { pt } from './i18n/pt';

const DICTS: Record<string, Record<string, string>> = { vi, es, pt };

const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
const dict: Record<string, string> = DICTS[lang] ?? {};

export const locale = DICTS[lang] ? lang : 'en';

export function t(key: string, fallback: string): string {
  return dict[key] ?? fallback;
}
