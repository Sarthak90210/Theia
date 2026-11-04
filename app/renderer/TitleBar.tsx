/**
 * Theia's own title bar. Windows draws its title-bar icon at 16 px whatever
 * the image, so the window's native bar is hidden (titleBarStyle 'hidden' in
 * main.ts) and this one shows the logo at a size you can see. Windows still
 * draws the minimise, maximise and close buttons over the right-hand end, so
 * they work and look as usual, and the bar drags the window.
 */
export function TitleBar() {
  return (
    <header className="titlebar" aria-label="Theia">
      <img src="theia-logo.png" alt="" aria-hidden="true" draggable={false} />
      <span>Theia</span>
    </header>
  )
}
