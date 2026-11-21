# Liquid Glass

Theia's interface follows the design language Apple introduced in 2025 with
macOS Tahoe and iOS 26. This note records what that language asks for, what
Theia took from it, and how it is built.

## What Apple's design asks for

From the WWDC25 sessions and Apple's Liquid Glass adoption guide:

- **Two layers.** Content runs edge to edge. The navigation layer (toolbars,
  tab bars, sidebars, controls) floats above it as Liquid Glass, a material
  that bends and focuses light from what is behind it and adapts its tint to
  what passes underneath.
- **Group, do not decorate.** Related toolbar buttons share one piece of
  glass. Titles and status text are not glass. Glass on custom controls is
  used sparingly.
- **Sidebars float** as a pane of glass beside the content; inspectors are
  edge-to-edge glass alongside it.
- **Scroll edge effect.** Where content scrolls under a bar, it softens, so
  the bar's labels stay readable.
- **Concentric shapes.** Capsules (radius half the height), and corners that
  nest inside the corners around them.
- **Legibility first.** Reviewers of the first Tahoe builds criticised Photos
  for buttons so transparent they fought the photos; later builds added more
  structure behind them. Accessibility settings (Reduce Transparency, Increase
  Contrast, Reduce Motion) turn the effect down.

Sources: [WWDC25 session 310](https://developer.apple.com/videos/play/wwdc2025/310/),
[Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass),
[Six Colors on macOS 26](https://sixcolors.com/post/2025/09/macos-26-tahoe-review-power-under-glass/),
[MacStories on Tahoe](https://www.macstories.net/stories/macos-tahoe-the-macstories-public-beta-preview/).

## What Theia does

- **The grid scrolls under a floating toolbar.** The toolbar is no longer a
  band above the photos; the photos start below it (`Grid` `insetTop`) and
  scroll on underneath, softened by a blur-and-fade scroll edge.
- **Glass where it is navigation**, built on React Bits' GlassSurface: an SVG
  displacement map as a backdrop filter, so the edge of each piece of glass
  bends the photos passing under it (`app/renderer/glass/Glass.tsx`):
  - toolbar: the sidebar button; Select, Save and Info as one capsule; the
    Years, Months, Days, All Photos segmented control, whose glass thumb
    slides to the chosen tab with a little overshoot; search; tile size;
  - the selection bar, now a capsule floating at the bottom over the photos;
  - the photo viewer's bar and the video player's controls.
- **Thicker frosted glass** for panels that are not over the photos: sidebar,
  info panel, menus, dialogs, toasts, and the status pill (bottom left, shown
  only when there is something to say). Dialogs are nearly opaque: they hold
  reading and controls.
- **The window itself** lets the Windows 11 acrylic material through the
  title bar and the sidebar, so the desktop shows faintly behind them, as
  glass on a Mac takes on the wallpaper. The content area stays solid, so
  photos look as they are. Windows 10 and older Windows 11 builds keep an
  opaque window.
- **Motion**: buttons press in with a spring; menus pop, sheets rise, the
  selection bar rises in. Short, and off with Reduce Motion.
- **The welcome screen** (no vault open) puts "Your photos, at home." under a
  drop of liquid glass that follows the pointer and changes shape when
  clicked (React Bits FluidGlass), with the first things to do as glass icons
  (React Bits GlassIcons).
- **Legibility**: glass over photos carries a tint of the theme's panel colour
  (more for bars at the bottom, which have no scroll edge), and every theme,
  light or dark, colours the glass.

## Turning it down

Settings, Theme, **Liquid Glass**: off gives plain frosted panels and an
opaque window, lighter on older graphics. Windows' own "Transparency effects"
switch (which sets `prefers-reduced-transparency`) does the same, and "Show
animations" (`prefers-reduced-motion`) stops the motion.

## Cost

Each piece of glass over the photos is one SVG filter re-run as the photos
scroll beneath it: about eight on screen at most. The acrylic is drawn by
Windows, not the app.
