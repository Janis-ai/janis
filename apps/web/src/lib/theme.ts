/** Light/dark theme — stored in localStorage, applied to <html data-theme>.
 *  Dark is the default; 'light' is opt-in for demos and daylight use. */

const KEY = 'janis_theme';
/** window event fired when the theme flips — img-based marks can't follow
 *  a CSS var, so listeners swap src to the light/dark variant. */
export const THEME_CHANGE_EVENT = 'janis:theme-change';

export function currentTheme(): 'dark' | 'light' {
  return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
}

export function applyTheme(t: 'dark' | 'light') {
  if (t === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
}

export function setTheme(t: 'dark' | 'light') {
  localStorage.setItem(KEY, t);
  applyTheme(t);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}
