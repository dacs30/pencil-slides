# Pencil Slides

A local, single-user slide studio: **real OpenPencil editing**, Vue 3, CanvasKit, SQLite, and a server-side Claude tool-use assistant. This is an MVP, not a hosted service.

## Workspace

The original **Pencil Slides** interface uses a Claude-inspired chat-and-artifact layout, not Anthropic branding or assets: warm ivory surfaces, charcoal text, muted terracotta accents, and restrained controls. Conversation is on the left; the active slide is the large, focused artifact on the right. On narrow screens the slide artifact stacks above the conversation.

- **Text** inserts editable text. **Shapes** offers working rectangle and ellipse tools.
- **Properties** reveals slide naming/background, element selection, geometry/text/fill controls, and slide reordering/deletion.
- The bottom strip provides previous/next navigation, collapsible thumbnails, Add slide, zoom controls, and Fit. Export PNG, PowerPoint, and Present remain at the top.
- The anchored composer shows the live selection. Use Send or ⌘/Ctrl+Enter. Prompt suggestions populate the composer without sending anything.
- Successful AI edits produce clickable **slide artifact cards** in the conversation. Expand an action summary to inspect factual editor calls, errors, and durable-save revisions—not generated reasoning. Cards and action results survive reload in SQLite; existing conversations migrate without being discarded. Historical cards identify the saved revision but open the **current** deck, not an archived snapshot.
- **Comments** opens a local review sidebar with point/object pins, replies, resolve/reopen, and an explicit handoff to Claude. Comments are separate from artwork and never appear in exports.
- The displayed canvas surface is clipped to the active slide plus an editing margin, so adjacent frames do not distract. This is a CSS viewport mask over the real CanvasKit surface; the document graph, all slides, native editing, and exports remain intact. Resizing the workspace refits the slide.

### Floating selection toolbar

Click one text object, rectangle, or ellipse to reveal a compact formatting toolbar above its bounds. It follows pan/zoom and movement, flips below when needed, and stays within the canvas viewport. Native resize/rotation handles are unchanged; the toolbar hides during those gestures, text editing, right-click menus, comment placement, AI runs, and presentation.

- **Text:** font size, text color, Bold, Italic, Underline, and horizontal alignment.
- **Shapes:** fill, single-outline color/width, width/height, and uniform corner radius for rectangles. Outline width `0` removes the outline.
- **Both:** Comment opens the existing object-anchored thread composer; Properties opens and focuses the current object's inspector.

Formatting uses the same validated SDK graph mutations, single-step history, durable save, and reload path as the inspector. Numeric drafts are buffered through render updates; commit with Enter or blur. Escape cancels an uncommitted input, clears selection, and returns canvas focus. Keyboard input inside the toolbar does not invoke canvas shortcuts.

This is **single-object, whole-text-object formatting**: multiple selections hide the toolbar. Changed text attributes are applied across existing rich-text runs while unrelated attributes remain intact; mixed attributes have mixed pressed/input states. Font family is unchanged (no font picker); the SDK handles face resolution and may synthesize italic from a loaded family when an exact italic face is unavailable. Multiple-outline editing, links, lists, and partial text-range formatting are not added here. The toolbar is a DOM overlay and never enters PNG/PPTX/presentation exports.

## Run

Requires **Node.js 24+**, npm, and a modern browser with WebGL enabled.

```sh
cd pencil-slides
npm ci
cp -n .env.example .env
# Optional: edit .env and set ANTHROPIC_API_KEY to enable Claude.
npm run dev
```

Open **http://127.0.0.1:5173**. Fastify listens on **127.0.0.1:3001**. Keep the default API port for development. Both processes are foreground children of `npm run dev`; Ctrl+C stops them. No API key is needed for editing, saving, export, or presentation.

For the built application:

```sh
npm run build
npm start
# Open http://127.0.0.1:3001
```

`PORT` changes the production/API port. `ANTHROPIC_MODEL` defaults to `claude-sonnet-4-6`; set it to a model available to your Anthropic account. Restart the API after changing `.env`. The key is read only by the backend; do not use a `VITE_` prefix.

`.env` and `.env.*` files are ignored by Git, except for the empty-key
`.env.example` template. Local databases, conversations, screenshots, generated
assets, dependencies, and build output are also ignored. Never put credentials
in source files or commit exported decks containing private content.

## What works

- Multiple local decks, naming, reopening the last deck, persistent chat transcripts.
- One OpenPencil document/page per deck; each slide is a top-level **1920 × 1080 FRAME**. Stable IDs, titles, and ordered slide metadata are stored separately.
- Insert text, rectangles, and ellipses. Select layers or canvas elements; drag, resize, double-click text to edit, or use the properties panel for text, fill, geometry, rotation, and font size.
- Add, rename, reorder, and delete slides; edit slide backgrounds.
- CanvasKit-generated thumbnails, **1920 × 1080 PNG export** of the active slide, and presentation view (←/→, Escape). Slides are fixed artboards; dragging content outside keeps it associated with its slide and clipped.
- **PowerPoint `.pptx` export of the entire deck**, with editable text/basic shapes where supported, explicit whole-slide image fallback, and an optional exact-appearance mode.
- Native OpenPencil undo/redo. Each structured AI/manual batch is a **single undo entry**, including slide metadata. Undo/redo are saved as new revisions. History itself is session-local, not persisted across reload.
- Official `@anthropic-ai/sdk` streaming text and tool-use loop, selection-aware reads/updates, cancellation, real failure propagation, and bounded execution.

Text editing commits on Escape, outside clicks, or an explicit save action. Wait for **Saved · rN** before closing. Unsaved edits/active runs trigger an unload warning and block switching decks. The editor locks during a save or AI run so asynchronous writes cannot mix with manual edits.

### Example AI requests

- “Create a three-slide pitch for a neighborhood bike repair shop.”
- Select a title: “Make this headline shorter and increase its font size.”
- “Read slide 2, simplify its copy, and move it to the beginning.”

AI usage sends the prompt, recent chat, and requested deck/slide/selection context to Anthropic and may incur charges. No other AI provider, arbitrary eval, filesystem, or shell tool is exposed. Do not include sensitive material you do not want sent to Anthropic.

## PowerPoint export

Open **PowerPoint** in the slide toolbar:

- **Editable .pptx** exports native PowerPoint text boxes, rectangles, and ellipses when the slide can be represented reliably. Positions, dimensions, stacking order, solid fills/alpha, simple centered outlines, rotation, horizontal/vertical text alignment, regular/bold/italic text, font size, explicit line height, and letter spacing are mapped from the actual OpenPencil graph.
- **Exact appearance .pptx** uses one **1920 × 1080 rendered PNG per slide**. The image can be moved/replaced, but its text and shapes are **not individually editable**. Use this mode when matching the rendered canvas matters more than editability.

Both modes export **all slides in the deck's metadata order**, at 16:9 (13⅓ × 7½ inches). At this chosen slide size, 144 design pixels equal one inch, and 2 design pixels equal one typographic point. Slide titles and conversion/fallback details are included in PowerPoint notes; the deck title is stored in presentation metadata. There is no custom speaker-notes editor.

An editable export deliberately falls back to a **whole-slide image** if any visible content on that slide needs unsupported features: gradients/multiple fills, masks/blending, effects, rounded corners/custom vectors, grouped/nested content, clipped edge content, mixed text runs, advanced typography, non-regular/non-bold font weights, missing renderer fonts, or text measured to overflow its box. This preserves layer ordering, clipping, and compositing instead of dropping nodes or baking an image over duplicate editable text. Other compatible slides in the same file remain editable.

The export notification reports **how many slides are editable and how many are images**. Expand **Export details & font requirements** to see each slide's reason. Fallback details are also written into the file's notes. If a slide cannot render, export fails visibly; no partial deck is downloaded. Hidden elements remain hidden/omitted.

**Font/layout limitations:** fonts are referenced by family, **not embedded**. Install Inter (or the reported font families) on the machine opening the PowerPoint file. PowerPoint/Keynote/LibreOffice use different text-layout engines, so editable text may wrap or space differently even when the font is installed. Native output does not promise pixel-perfect typography; choose exact appearance to avoid that reflow. Transparent slide backgrounds are composited against white in image mode. Very large decks can take time and produce larger files.

Export saves current changes first, locks editing while working, and builds from an isolated snapshot. PptxGenJS and the export adapter are **dynamically imported only when requested**. Rendering and file generation stay in the browser; no API key or external conversion service is involved. The existing PNG action still downloads only the active slide.

## Comments

Open **Comments** in the toolbar:

1. Choose **Pin a point**, then click inside the slide. For keyboard placement, use arrow keys (Shift for larger steps) and Enter/Space. Escape or **Cancel pinning** exits without changing artwork. Point mode intercepts canvas input; it cannot move or create shapes.
2. Or select an element on the canvas/in Properties, then choose **Comment on selection**. The pin follows that stable object ID as it moves or rotates.
3. Write a note and choose **Post comment**. Click a numbered pin or thread header to navigate to its target slide, read replies, and add your own reply.
4. **Resolve thread** hides the thread and pin by default. **Show resolved** reveals them; select a resolved thread and choose **Reopen thread** to continue.

This is a single-user local feature: every message is labeled “You.” There are no simulated teammates, permissions, sharing links, or comment deletion controls. Comments/replies work without an AI key.

### Right-click to comment

Right-click the slide canvas and choose **Add comment**. The menu targets the actual object under the pointer using OpenPencil's scoped hit testing—not the previous selection. Right-clicking empty slide space starts a point-anchored comment at that location. Outside the slide, Add comment is disabled.

With the canvas focused, **Shift+F10** or the **Context Menu key** opens the same menu for the current slide's selected object (or the slide center when nothing eligible is selected). Arrow keys/Home/End focus the available action; Enter/Space activates it. Escape/Tab dismisses and restores canvas focus. Clicking elsewhere dismisses without stealing focus from the clicked control. Choosing Add comment focuses the existing comment composer; storage, validation, and lifecycle are the same as toolbar comments.

The popup is clamped to the browser viewport and closes when the slide/viewport changes. Right-click input is intercepted before SDK drag/draw handlers, so opening or cancelling the menu does not create or move artwork. This canvas shell did not previously mount a native SDK context popup; the app-owned menu uses real SDK hit testing without adding fake editor actions. Native browser menus in chat, comment textareas, and other forms remain available. The Comments toolbar/sidebar remains available for discoverability and non-mouse access.

### Anchors and persistence

Threads and messages live in separate SQLite tables (`comment_threads`, `comment_messages`), not in OpenPencil nodes or deck snapshots. Saving a comment does not increment the artwork revision. Saves validate the current deck revision, slide ID, object ID, body limits, and thread version; retries use stable request IDs to avoid duplicate posts. Failed loads/saves appear in the sidebar and preserve the draft. Unsent comment/reply drafts block switching decks and trigger the browser unload warning.

Pins are DOM overlays on the actual SDK canvas, using its client rectangle, pan/zoom, frame transform, and object geometry. They do not enter CanvasKit renders, PNGs, PPTX files (including image-fallback slides), thumbnails, or presentation images.

An object thread stores its **original slide-local fallback coordinates**. Durable deletion or movement to another slide permanently detaches it, keeping the thread and displaying a dashed pin at that original position when the original slide remains available. Reusing the object ID—even by undoing a deletion—does **not** silently reattach it. Deleted-slide threads stay in the sidebar, clearly detached, without a pin or active-slide AI action. Original slide/object labels remain available for historical context. Off-slide objects remain listed even when their pin is outside the viewport.

Detachment is recorded in the **same SQLite transaction as the artwork save**. Resolved state, messages, anchors, and detachment survive restart. The editor currently persists flat text/shape children; comment projection uses SDK world transforms and is tested with nested/rotated geometry, but this does not add group editing/import support.

Limits: **100 threads per deck, 50 total messages per thread, and 2,000 characters per message**. No automatic pruning or destructive deletion is performed.

### Ask Claude to address this

Nothing is sent to AI simply by creating, selecting, replying to, or resolving a comment. **Ask Claude to address this** explicitly sends that thread and its referenced slide/object context through the existing streamed chat pipeline. The unrelated main-composer draft is preserved.

The backend loads the thread by deck ID and version, rejects stale/resolved/deleted-slide handoffs, and treats comment text as **untrusted user data**, never system instructions. The first post and up to nine recent replies are included with a bounded context budget; any truncation is flagged. A successful `read_context` for the referenced slide at the **current revision is required before mutation**. Subsequent AI batches still use command IDs, revision checks, atomic rollback, and durable save acknowledgements. Busy runs disable comment handoff/actions in the UI.

Claude does **not** auto-resolve the thread after submission or a successful edit. Review the actual result and resolve it yourself. Detached-object handoffs explicitly identify the missing/moved target and use the surviving slide context instead of treating a replacement ID as the original object.

## Architecture and durability

| Area | Files |
|---|---|
| Chat-first workspace and browser command adapter | `src/Workspace.vue` |
| Persisted chat artifact cards | `src/ArtifactCard.vue`, `shared/chat.ts` |
| Real SDK rendering, pointer input, text/IME | `src/CanvasPane.vue` |
| Graph snapshot/restore and structured mutations | `src/document.ts` |
| Editable PowerPoint conversion, fallback planning, image rendering | `src/pptx-export.ts`, `src/pptx-raster.ts` |
| Comment validation, storage, lifecycle and handoff | `shared/comments.ts`, `server/comments.ts` |
| Comment sidebar, input mode and geometry overlays | `src/useComments.ts`, `src/CommentsSidebar.vue`, `src/CommentOverlay.vue`, `src/comment-geometry.ts` |
| Canvas-only context menu, hit targeting and keyboard placement | `src/CanvasContextMenu.vue`, `src/canvas-context.ts` |
| Floating selection formatting and viewport placement | `src/SelectionToolbar.vue`, `src/selection-toolbar.ts` |
| Shared validated tool/snapshot contracts | `shared/model.ts` |
| Fastify API, SSE runs, acknowledgements | `server/app.ts` |
| Official Anthropic SDK and bounded tool loop | `server/agent.ts` |
| SQLite revisions, receipts, chat | `server/store.ts` |

`read_context` returns the live revision, active slide, selection IDs, slide metadata, and requested node properties. `apply_batch` only accepts the enumerated operations in `shared/model.ts` and an `expectedRevision`. Newly created IDs are supplied by the model and checked for uniqueness.

The browser validates commands, captures a before-snapshot, applies the bounded batch synchronously to the SDK graph, validates the resulting slide topology, and submits a snapshot with its command ID and expected revision. SQLite updates the snapshot, increments the revision, and records the command receipt **in one transaction** (`WAL`, `synchronous=FULL`). Only then does the browser add its undo entry and acknowledge success. The server independently checks that the receipt exists before giving Claude a successful tool result.

Failed batches restore the before-snapshot and return an error. Save retries reuse the exact payload and command ID; duplicate IDs with different content are rejected. Lost responses are reconciled against durable receipts. If the outcome cannot be determined, editing pauses until reload rather than pretending success. Concurrent/stale revisions return HTTP 409; reload to recover the latest durable deck. Already committed batches remain saved when cancelling; cancellation stops subsequent work, not completed changes.

Limits: 100 slides, 2,000 nodes, 100 operations per batch, 12 MiB request body, 10 model rounds, 30 tool calls, 30 seconds per browser command, 120 seconds per run. At most one AI run per deck. Runs are intentionally not resumed after a server/browser restart.

Data is stored in **`data/pencil-slides.sqlite`** (ignored by Git). To back up, stop the app and copy the database; while running, SQLite may also have `-wal` and `-shm` files. Do not delete `data/` to “reset” if it contains wanted decks.

## SDK integration notes

OpenPencil `core`, `scene-graph`, and `vue` are pinned together at **0.15.0**; CanvasKit is pinned at **0.41.1**. The application uses `createEditor`, `provideEditor`, `useCanvas`, `useCanvasInput`, and `useTextEdit`; the canvas is not an SVG/DOM imitation. It uses the lower-level SDK canvas composable to avoid the published `CanvasRoot`/`CanvasSurface` nested-ref mount timing issue.

- `scripts/assets.mjs` copies the packages' CanvasKit WASM and bundled Inter/fallback fonts into ignored `public/` during install. No CDN is needed for normal editing. If install scripts were disabled, run `node scripts/assets.mjs`.
- The 0.15.0 package ships JavaScript workers but retains `.ts` URLs in three emitted clients. The narrowly scoped Vite plugin corrects those URLs without modifying `node_modules`. Explicit dependency prebundling also makes the SDK's CommonJS dependencies work in Vite development.
- The SDK text-input bridge expects utility CSS. The host supplies its hidden-textarea styling without requiring Tailwind.
- The build emits upstream browser-externalization warnings for guarded Node-only SDK paths and a large-bundle warning. These do not prevent the verified browser build from working.

## Tests and verification

```sh
npm test          # Node tests: real SDK graph/history, validation, SQLite reopen,
                  # revision/idempotency, API origin guards, mocked streamed tools,
                  # generated PPTX ZIP/XML geometry, text, order, notes and fallback,
                  # comment lifecycle, detachment, geometry and explicit AI handoff
npm run build    # Strict TS/Vue typecheck plus production bundle
```

A separate, deterministic provider can exercise the **actual built browser adapter → SSE → SQLite → acknowledgement** flow without a key:

```sh
npm run build
npx tsx tests/browser-server.ts
# Open http://127.0.0.1:3002; separate data/browser-test.sqlite
```

This is a test-only entry point, never enabled by the normal server. Select a title and send any prompt: it creates a slide and changes that selected title in one atomic batch. Send `fail` to test partial-batch rollback, `conflict` to test stale-revision rejection, or `cancel` then Stop to test abort. Ctrl+C stops the test server.

The same fixture supports comment handoff: create a comment on a selected text object, then choose **Ask Claude to address this**. It reads the referenced slide, updates that text through the real browser/SQLite acknowledgement flow, and leaves the thread unresolved. This is deterministic provider testing, not a live Anthropic call.

Playwright verification covered the real CanvasKit surface, text insertion/property edits, native double-click text editing, native rectangle drag/resize, save/reload, undo/redo, slide ordering, thumbnails, PNG download, and presentation image dimensions. The deterministic provider also exercised browser-side selected-text updates, atomic AI undo/redo, rollback, revision failures, cancellation, and persisted chat after restart. **No live Anthropic request was verified without a configured API key.**

PowerPoint verification includes actual browser downloads in editable, mixed-fallback, and exact-appearance modes. Downloaded ZIP/XML was checked for native text/shapes versus pictures, all-slide counts, and embedded 1920×1080 PNG dimensions. Unit tests additionally check metadata order, positions/sizes, typography/alignment, transparency, notes, unsupported-content detection, and failure handling. The rendered fallback image was visually inspected. Desktop PowerPoint/Keynote rendering was not automated; the font/reflow limitations above still apply.

Comment verification covers real point/object posting, replies, resolve/reopen and filtering, reload persistence, native object dragging with following pins, detached threads after deletion/undo, thread-to-slide navigation, Escape/keyboard placement, responsive mobile pinning, and mocked Claude handoff preserving the unrelated composer draft. Exported PNG/PPTX image pixels at a visible pin location were checked against the clean slide background; comment text was absent from PPTX XML, and presentation mode removed the pin overlay. Unit tests cover SQLite reopen/idempotency, validation, permanent detachment/ID reuse, nested transform math, and mandatory current-context reads before comment-driven AI changes.

Context-menu checks cover right-clicking a different object than the selection, background placement after pan/zoom, disabled outside-slide actions, viewport edge clamping, Shift+F10/Context Menu key, keyboard activation, Escape/outside-click focus handling, and native chat menus. Both object and point comments were posted through the real UI with the artwork revision and node count unchanged.

Selection-toolbar verification covers normal left-click and touch selection, pressed formatting states, font/color/alignment changes, outline/radius/size edits, undo/redo and reload, input drafts across redraws, keyboard Delete/Escape scoping, Comment/Properties focus, native dragging/resizing, multi-select hiding, context-menu/text-edit coexistence, and mobile placement. Export pixel/XML checks confirm the overlay does not enter PNG/PPTX output; presentation hides it. Unit tests cover supported selection types, transformed bounds and edge placement, rich-run preservation, validated shape styling, and durable history round-trips.

## Deliberate MVP boundaries

Localhost only, no authentication, one user/editor tab recommended. Host/origin guards and loopback binding are not a substitute for authentication: **do not expose the API with a public tunnel, proxy, or port forward**. Other local processes have the same access as you.

No collaboration, public hosting, generated/imported images, arbitrary OpenPencil/Figma import, rich theme system, speaker-notes editor, or cross-session undo history. Slides support text and basic shapes only. Fonts use the SDK's bundled Inter; this is not a general font-management UI. Large decks can be slower because persistence uses full snapshots and thumbnails use actual raster rendering.
