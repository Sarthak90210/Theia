# Editor interaction research

Reviewed on 4 November 2026 against official product support documentation.
The previous Theia editor put crop boundaries behind sliders and repeatedly
rendered an already-cropped image. That makes a spatial task indirect: the user
cannot grab the visible boundary or see the excluded area while composing.
The implementation priorities below are engineering recommendations drawn from
the documented interaction patterns, not a claim of feature parity.

## What the established editors do

### Apple Photos

Cropping happens on the image. People drag rectangle corners, keep or unlock
the aspect ratio, choose a standard ratio, rotate by quarter turns and flip.
Apple distinguishes those spatial controls from the dial used for fine
straightening or perspective changes. Cancel/discard and reset/revert make
the editing session reversible. This supports keeping sliders for tonal or
angular values, while replacing crop-boundary sliders with image handles.
[Apple Photos crop, rotate, flip and straighten](https://support.apple.com/guide/iphone/crop-rotate-flip-straighten-photos-videos-iph0f3ebb1dd/ios)

For video, Photos exposes a frame viewer below playback. Dragging either end
sets the retained interval. Saving as a new clip preserves both versions;
Apple also offers saving the trimmed version. Theia should retain its explicit
copy-saving contract rather than introduce overwriting as part of this change.
[Apple Photos video trimming](https://support.apple.com/guide/iphone/trim-video-length-adjust-speed-and-edit-audio-iph1d1344a2d/ios)

### Google Photos

The desktop photo editor uses draggable crop edges and a rotate control.
Holding the photo temporarily reveals the original for comparison. Adjustments
have their own controls, and edits can be reverted. In shared albums Google
distinguishes saving changes from saving a private copy, so the save action's
consequences need to be clear.
[Google Photos desktop editing](https://support.google.com/photos/answer/6128850/?co=GENIE.Platform%3DDesktop&hl=en)

Google Photos on iPhone and iPad uses draggable video trim handles. Crop,
rotation, adjustments and mute are separate tools, and saving a copy is
explicit. These are documented mobile behaviors; they should not be presented
as a claim that the desktop web editor has every mobile video tool.
[Google Photos video editing on iPhone and iPad](https://support.google.com/photos/answer/10729480?co=GENIE.Platform%3DiOS&hl=en)

### Microsoft Photos

Windows Photos shows manual cropping with the original visible behind the
selected area, aspect presets, rotation and flipping. Light/colour adjustments
use sliders. Holding the image or pressing Space compares against the original,
and Reset removes the editing session's changes. Its video trim tool places
start/end markers below the video and offers Save as Copy, with overwriting
available separately. Microsoft directs advanced video editing to Clipchamp.
[Microsoft Photos editing](https://support.microsoft.com/en-us/windows/apps/photos/edit-photos-and-videos-in-windows)

## Theia's immediate interaction contract

- Show the full working image in Crop mode, including a dimmed excluded area.
  Put visible corner and edge handles directly on the crop frame and let the
  selection move inside the image. A thirds grid helps composition.
- Make dragging immediate. Move the frame locally while the pointer moves;
  do not wait for a full-resolution encode after every pointer event.
- Offer free cropping and aspect presets. A selected ratio stays constrained
  during resizing and movement. Rotation and flipping must keep the displayed
  selection aligned with the pixels that will be saved.
- Provide keyboard equivalents for moving/resizing the frame, clear focus
  indicators and hit targets larger than the visible handle strokes.
- Keep sliders for exposure, contrast and saturation. Those are continuous
  scalar adjustments, unlike picking a rectangle on an image.
- Provide temporary before/after comparison, undo/redo during the editing
  session and a clear reset. A drag should be one undoable action, not hundreds.
- For video, use a visual timeline with two trim handles, a playhead and
  playback of the selected interval. Numeric times can supplement that control.
- Keep Save as copy explicit. Disable saving while the required source or
  export is unavailable, preserve original bytes and report export failures.

## Limits to state honestly

This work should improve the editing interaction, not imply an entire
professional editor has been implemented. Theia's existing recipe supports
quarter-turn rotation, horizontal flip, rectangular crop, exposure, contrast,
saturation, video start/end and mute. Fine straightening, perspective correction,
RAW development, subject masks, HDR-preserving export and a persistent
nondestructive editing history require separate rendering and data-model work.
Adding lookalike controls without those implementations would make the editor
less trustworthy.

## Acceptance evidence

Test actual pointer drags on corners, edges and the selection interior. Include
portrait and landscape media, each quarter-turn/flip combination, free and
locked ratios, image-boundary clamping and the minimum window size. Compare the
saved copy's dimensions and framing with the selected region. Verify undo/redo,
original comparison and cancellation without changing the original. For video,
verify both trim endpoints, selected-interval playback and exported duration.
