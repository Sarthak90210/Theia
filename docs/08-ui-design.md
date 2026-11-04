# Theia UI design

Reviewed against Apple's current Human Interface Guidelines on 4 November 2026.
These are desktop web components in Electron on Windows, adapted from Apple's
principles. They do not use Apple's native Liquid Glass APIs or SF assets.

## Materials and colour

Apple separates functional glass surfaces from the content layer and recommends
using the effect sparingly. Theia uses translucent, blurred surfaces for its
sidebar, menus, viewer toolbar and playback controls. The photo canvas stays
solid, and the inspector uses opaque grouped surfaces for readability.
[Materials](https://developer.apple.com/design/human-interface-guidelines/materials)

For visually rich content, Apple recommends monochrome controls and restrained
colour emphasis. Theia's main palette is neutral and permanently dark, as requested by the user. Selection
also has an outline and checkmark; active controls have a shape or weight change.
Colour remains available for keyboard focus and meaningful error states.
[Colour](https://developer.apple.com/design/human-interface-guidelines/color)

## Hierarchy and controls

Toolbar actions are grouped by purpose. The collection title, time grouping,
tile size and contextual selection actions occupy separate rows, which can
adapt to the available width. The viewer keeps its controls over a dark glass
surface and keeps the media prominent.
[Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)

The sidebar groups devices, vaults, collections and utilities. A toggle allows
more room for content. The inspector becomes a floating panel in compact
windows rather than squeezing the media into an unusable column.
[Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)

One system typeface, a limited type scale, consistent icon strokes and generous
spacing establish hierarchy without adding decorative colours or extra labels.
[Typography](https://developer.apple.com/design/human-interface-guidelines/typography)

## Accessibility and verification

Menus, segmented controls, dialogs and the editor support keyboard navigation.
Dialogs contain focus and restore it on close. Focus indicators remain visible;
reduced motion, reduced transparency, increased contrast and forced colours have
CSS fallbacks. These are web accessibility adaptations, not a claim that every
Windows assistive-technology combination has been qualified.
[Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)

Visual QA uses isolated synthetic vaults under both light and dark system preferences, including
compact windows, an open inspector, selected items, menus, confirmation dialogs,
photo/video editors and utility collections. No personal files are edited during
this verification. See `scripts/prepare-ui-polish-qa.ts` and
`scripts/qa-ui-polish.cjs`.
