/**
 * Apply the host's theme to the document.
 *
 * Views run in a sandboxed iframe, so the host tells us which theme to use rather
 * than us reading anything from the page around us.
 */
export function applyTheme(theme: string | undefined): void {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}
