# Pencil: documents, slides and pages

A browser-local creative studio: **Tiptap rich-text documents**, **real OpenPencil slides and designed pages**, Vue 3, CanvasKit, IndexedDB, and a small server-side Claude relay. It can run locally or on Render without a persistent server disk.

## Conversations and artifacts

One conversation can contain multiple **documents, slide decks and pages**. Use **+ Document**, **+ Slide deck**, or **+ Page**, switch with **Choose artifact**, or ask Claude to create them. Chat belongs to the conversation, not to a single deck. Each assistant response keeps one card per artifact: creation and later saves update that first card in place. Existing duplicate cards are coalesced when history loads. Cards identify the latest saved revision in that response but open the current artifact, not an archived snapshot.

Every browser profile has its own IndexedDB workspace for this site's origin. Tabs on the same origin share that workspace; other browser profiles and devices do not. The server has no artifact, comment or chat database, and it does not expose workspace read/write endpoints. AI requests still send the requested context through the server to Anthropic.

Use **Browser storage → Export workspace backup** before clearing browser data, changing devices, or moving from localhost to a hosted domain. **Import workspace backup** validates the file and adds new conversations with remapped artifact/comment IDs; it never overwrites existing work. Backups include artifacts, comments and chat, but not session-local undo history or in-flight AI runs. Import currently accepts files up to 50 MiB. Browser storage can be cleared or evicted, and private-browsing storage may disappear when that session ends.

The previous SQLite workspace is retired; there is no automatic migration or server-side workspace store in the normal application. Server-side SQLite modules remain as legacy regression fixtures only and are not imported by the production entry point.

`src/ConversationWorkspace.vue` owns the shared conversation, artifact switching, and streamed command dispatch. Editors expose the same adapter contract: `flush`, `execute`, and `context`. `src/local-store.ts` owns IndexedDB transactions; `src/local-api.ts` adapts the existing editor APIs to local storage. Saves retain the receipt-reconciliation helper in `src/artifact-save.ts`, but receipts are now browser-owned.

Assistant replies render as sanitized GitHub-flavored Markdown while streaming and after reload: headings, emphasis, lists, links, tables, inline code and fenced code blocks. User messages and comment bodies remain plain text. Raw HTML is shown as text, external images are represented by their alt text rather than loaded, and links are restricted to HTTP(S) and mailto with opener protection. `src/MarkdownMessage.vue` uses Marked and DOMPurify; model output cannot create active scripts, forms or embedded content.

### Rich-text documents

Documents use Tiptap/ProseMirror, not OpenPencil. The editor supports paragraphs, headings 1-3, bold, italic, underline, strikethrough, inline code, highlighting, safe links, bullet/numbered lists, block quotes, code blocks, and horizontal rules. Select text to reveal its floating formatting toolbar. Lists and heading styles are also available in the document toolbar. Native typing, paste, selection, and keyboard undo/redo operate on real rich text.

Content is persisted as validated ProseMirror JSON. The browser checks that replaying submitted steps produces the snapshot and title, maps comment ranges, increments the revision, and writes the command receipt in one IndexedDB transaction. Manual edits autosave after 1.5 seconds of idle time, with a ten-second maximum delay during continuous typing. Background saves do not disable the editor, reset its content, move the cursor, or hide formatting controls. Each request captures an immutable prefix of transactions; typing and title edits made during that request remain queued for the next revision. Explicit export/review actions flush pending work. AI batches form one undo event, including title changes. Undo/redo are saved as new revisions. Unknown save outcomes pause editing rather than allowing a potentially divergent document. Wait for **Saved rN** before closing. History is local to the mounted editor; switching artifacts or reloading starts a new undo history.

Select text and choose **Comment** to start a range-anchored review thread. Comments support replies, resolve/reopen, original quoted text, and explicit **Ask Claude to address this**. Anchors follow ProseMirror position maps, not searches for matching words, so repeated text does not confuse their targets. Removing the entire selected range permanently detaches its thread; undoing deletion does not silently reattach it. Comments are stored separately from document content and never appear in Word export. Unsent comment/reply drafts block artifact and conversation switching. Limits are 100 threads per document, 50 messages per thread, and 2,000 characters per comment or selected quote.

**Export Word** downloads an editable `.docx` using semantic paragraphs, heading styles, list numbering, text formatting, and hyperlinks. Generation stays in the browser and the exporter loads only when requested. The file uses US Letter with one-inch margins and Arial defaults; fonts are not embedded. It is not a screenshot or a Microsoft Word embed. Browser layout and Word pagination can differ. Export fails visibly if content cannot be represented, rather than silently dropping it.

The first document milestone deliberately excludes tables, images, checklists, reactions, document tabs, import/round-trip editing of existing Word files, exact print pagination, tracked changes, PDF export, and Google Docs/Notion publishing. These are not implied by the corresponding controls in the Claude reference. Nested lists beyond nine levels cannot be exported to Word. Documents are bounded to 5,000 nodes, 24 nesting levels, and 600 KB of serialized content.

### Shared AI workflow

The assistant can `create_artifact`, `read_context`, and `apply_batch`. Reads and writes identify the artifact; document commands use ProseMirror positions rather than plain-text offsets, while slides retain their existing graph operations. Published Anthropic tool schemas have plain object roots (no top-level `oneOf`/`anyOf`/`allOf`). `operations` is one explicitly required array whose items enumerate the supported edits; runtime validation still strictly enforces the artifact kind. The relay requires a read before each mutation and a matching durable browser acknowledgement before reporting success. Only the browser can verify its IndexedDB receipt. Each open workspace view runs one AI request at a time; other tabs can produce revision conflicts. Editing and artifact/conversation switching are locked during a run.

The provider preserves Anthropic's stop reason. If a response reaches `max_tokens`, none of its tools are executed, even if an incomplete tool happens to parse as valid JSON. The agent receives explicit feedback to retry with a smaller batch; at most two such recoveries are allowed before a clear output-limit error stops the run. Already committed batches remain saved. Normal requests are guided toward small batches rather than a single large page payload. `tests/agent-output.test.ts` exercises this through the real SDK with a synthetic stream and no live credential.

Comment handoffs load the thread from IndexedDB, validate its version and resolved state, and send only its bounded context to the relay. The relay requires a fresh read of the referenced artifact (and slide for slide comments). Comment text remains untrusted data. Handoffs do not clear an unrelated main-composer draft or automatically resolve the thread.

### Designed pages

Empty hug-sized auto-layout frames are valid between saved batches, even when their computed height is zero. Children can be added in subsequent batches. Page frames support the same solid paint, outline, and uniform corner-radius controls as rectangles.

Ask for a **page** or **landing page**, or choose **+ Page**. This creates a third artifact kind backed by a real OpenPencil document, with one 320-1920-pixel-wide artboard and nested frames, text, rectangles and ellipses. It is not a rich-text document or a fixed-size slide. Double-click canvas text to edit, use the floating formatting toolbar, or open **Properties** for text, geometry, fill, layout, padding, and an outline of selectable elements. Use **Section** for a nested auto-layout frame. Undo/redo, revision checks, atomic AI batches and durable receipts follow the existing editing contract.

**Open full window** switches modes inside the same artifact, matching the reference's navigation rather than opening a new tab. It displays actual readable HTML without editing handles or properties. **Fill** uses the available viewport width; vertical/horizontal auto-layout sections and wrapping rows reflow. **Fit** preserves the design width and scales it to the available panel. **Back to canvas** restores the editor. Freeform-positioned content preserves its coordinates; use auto layout for responsive designs.

**Export HTML** downloads the saved page as a standalone, script-free HTML file. Text is escaped, styles are generated from validated graph properties, and a restrictive content security policy is included. In-app preview uses locally bundled Inter fonts; exported files reference font names without embedding font files and may fall back to Arial. HTML text layout can differ from CanvasKit. Unsupported fills/effects or other unrepresentable features produce an explicit preview/export error rather than a screenshot or silently dropped content.

Page tools are `update_page`, `create_page_element`, `update_page_element`, `delete_page_element`, and `move_page_element`, inside `apply_batch` with `kind: "page"`. Read with `view: "page"` or `view: "selection"`; selection reads include selected frames' descendants. `FRAME` supports vertical/horizontal/freeform layout, wrapping, sizing, spacing and padding; `TEXT` uses Inter with optional height auto-resizing. Limits: 500 nodes, 12 nested levels, 20,000 characters per text node, 20,000 pixels maximum node height, and a 4 MiB snapshot.

Page **Comments** uses the same local review flow as slides: pin a point, comment on selected text/shapes/sections, or right-click the canvas and choose **Add comment**. Keyboard placement follows the visible artboard and can move through tall pages; pins use the real frame dimensions rather than a slide-height limit. Nested and rotated objects use SDK world transforms. Threads support replies, resolve/reopen, reload persistence, and explicit **Ask Claude to address this**. A full current-page read is required before a comment-driven AI edit, and Claude never auto-resolves the thread.

Page comments live in the browser's separate comment store. They do not increment artwork revisions and never appear in full-window HTML or downloaded exports. Moving an object between sections of the same page preserves its attachment. Durable deletion permanently detaches the thread at its original page-local position; restoring the same object ID does not reattach it. Detachment is recorded in the artwork-save transaction. Unsent drafts block artifact/conversation switching. Limits remain 100 threads per page, 50 messages per thread and 2,000 characters per message.

The initial page release does **not** add multiple artboards inside one artifact, arbitrary HTML/CSS/script execution, remote images, forms, public page publishing, or external website imports. Page snapshots are typed records in the browser's artifact store. `src/PageEditor.vue` reuses `CanvasPane.vue`, the OpenPencil editor, shared graph restoration and formatting helpers. `src/page-html.ts` renders the HTML view; it does not run model-generated code.

Storage and relay entry points: `src/local-store.ts`, `src/local-api.ts`, `src/browser-chat.ts`, `shared/browser-storage.ts`, `shared/browser-chat.ts`, and `server/browser-app.ts`. Editor-specific contracts and export adapters remain separate. Legacy server database modules are not registered by the production entry point.

## Workspace

The **Pencil** interface uses a Claude-inspired chat-and-artifact layout, not Anthropic branding or assets: warm ivory surfaces, charcoal text, muted terracotta accents, and restrained controls. Conversation is on the left; the active document or slide deck is the large, focused artifact on the right. On narrow screens the artifact stacks above the conversation. The following controls describe slide decks.

- **Text** inserts editable text. **Shapes** offers working rectangle and ellipse tools.
- **Properties** reveals slide naming/background, element selection, geometry/text/fill controls, and slide reordering/deletion.
- The bottom strip provides previous/next navigation, collapsible thumbnails, Add slide, zoom controls, and Fit. Export PNG, PowerPoint, and Present remain at the top.
- The anchored composer shows the live selection. Press Enter or use Send (Shift+Enter inserts a newline). Prompt suggestions populate the composer without sending anything.
- Successful AI edits produce clickable **slide artifact cards** in the conversation. Expand an action summary to inspect factual editor calls, errors, and durable-save revisions—not generated reasoning. Cards and action results survive reload in IndexedDB. Historical cards identify the saved revision but open the **current** deck, not an archived snapshot.
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

## Deploy on Render

The included `Dockerfile` and `render.yaml` run a single Node 24 web service with **no persistent disk**. The blueprint uses Render's free plan for exploration; expect cold starts on that plan. A paid instance can avoid idle spin-down without changing storage.

1. Push the tested code to your GitHub repository, then create a Render Blueprint from it.
2. Set `ANTHROPIC_API_KEY` as a runtime secret. Do not use a `VITE_` variable or a Docker build argument for it.
3. Render supplies `PORT` and `RENDER_EXTERNAL_URL`. The container binds to `0.0.0.0`; the relay uses Render's external URL for its host/origin allowlist.
4. If using a custom domain, set `PUBLIC_ORIGIN` to its exact HTTPS origin, such as `https://your-domain.example`. Different domains have different browser storage; use backup/import when moving between them.
5. Keep one server instance: active AI runs and their capability tokens are transient process memory. Scaling the relay would require shared run coordination or sticky routing, even though workspace data is browser-local.

The health endpoint is `/api/health`. No database migration, volume, Redis or managed database is required. The normal server does not create or read `data/`. `.dockerignore` excludes environment files, databases and workspace backups.

For a non-Render host, set `HOST=0.0.0.0`, `PORT` to its assigned port, and `PUBLIC_ORIGIN` to the exact public HTTPS origin. Never copy a localhost `.env` into the deployment image; set hosted values through the provider's runtime environment settings.

This prototype deliberately has **no user authentication**. Browser-local storage prevents visitors from reading one another's workspace through the app, but it does not protect a shared server API key from public usage. Anyone who can reach the AI endpoint can consume credits. The existing tool/time/cancellation limits and an eight-active-run ceiling remain; these are not account authentication or a spending cap. Use only an API key and usage budget appropriate for a public experiment.

Workspace edits and exports do not require a working AI connection once the app is loaded. This is not an offline/PWA installation: loading the app itself still requires its static files to be available.

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

Threads and messages live in a separate IndexedDB comment store, not in OpenPencil nodes or deck snapshots. Saving a comment does not increment the artwork revision. Saves validate the current deck revision, slide ID, object ID, body limits, and thread version; retries use stable request IDs to avoid duplicate posts. Failed loads/saves appear in the sidebar and preserve the draft. Unsent comment/reply drafts block switching decks and trigger the browser unload warning.

Pins are DOM overlays on the actual SDK canvas, using its client rectangle, pan/zoom, frame transform, and object geometry. They do not enter CanvasKit renders, PNGs, PPTX files (including image-fallback slides), thumbnails, or presentation images.

An object thread stores its **original slide-local fallback coordinates**. Durable deletion or movement to another slide permanently detaches it, keeping the thread and displaying a dashed pin at that original position when the original slide remains available. Reusing the object ID—even by undoing a deletion—does **not** silently reattach it. Deleted-slide threads stay in the sidebar, clearly detached, without a pin or active-slide AI action. Original slide/object labels remain available for historical context. Off-slide objects remain listed even when their pin is outside the viewport.

Detachment is recorded in the **same IndexedDB transaction as the artwork save**. Resolved state, messages, anchors, and detachment survive restart. The editor currently persists flat text/shape children; comment projection uses SDK world transforms and is tested with nested/rotated geometry, but this does not add group editing/import support.

Limits: **100 threads per deck, 50 total messages per thread, and 2,000 characters per message**. No automatic pruning or destructive deletion is performed.

### Ask Claude to address this

Nothing is sent to AI simply by creating, selecting, replying to, or resolving a comment. **Ask Claude to address this** explicitly sends that thread and its referenced slide/object context through the existing streamed chat pipeline. The unrelated main-composer draft is preserved.

The browser loads the thread by artifact ID and version and rejects stale/resolved/deleted-artboard handoffs. The relay treats submitted comment context as **untrusted user data**, never system instructions. The first post and up to nine recent replies are included with a bounded context budget; any truncation is flagged. A successful `read_context` for the referenced slide at the **current revision is required before mutation**. Subsequent AI batches still use command IDs, revision checks, atomic rollback, and durable save acknowledgements. Busy runs disable comment handoff/actions in the UI.

Claude does **not** auto-resolve the thread after submission or a successful edit. Review the actual result and resolve it yourself. Detached-object handoffs explicitly identify the missing/moved target and use the surviving slide context instead of treating a replacement ID as the original object.

## Architecture and durability

| Area | Files |
|---|---|
| Chat-first workspace and browser command adapter | `src/ConversationWorkspace.vue`, `src/browser-chat.ts` |
| Persisted chat artifact cards | `shared/artifacts.ts`, `src/local-store.ts` |
| Real SDK rendering, pointer input, text/IME | `src/CanvasPane.vue` |
| Graph snapshot/restore and structured mutations | `src/document.ts` |
| Editable PowerPoint conversion, fallback planning, image rendering | `src/pptx-export.ts`, `src/pptx-raster.ts` |
| Comment validation, storage, lifecycle and handoff | `shared/comments.ts`, `src/local-comments.ts`, `src/local-store.ts` |
| Comment sidebar, input mode and geometry overlays | `src/useComments.ts`, `src/CommentsSidebar.vue`, `src/CommentOverlay.vue`, `src/comment-geometry.ts` |
| Canvas-only context menu, hit targeting and keyboard placement | `src/CanvasContextMenu.vue`, `src/canvas-context.ts` |
| Floating selection formatting and viewport placement | `src/SelectionToolbar.vue`, `src/selection-toolbar.ts` |
| Shared validated tool/snapshot contracts | `shared/model.ts`, `shared/artifacts.ts`, `shared/browser-chat.ts` |
| Fastify API, SSE runs, acknowledgements | `server/browser-app.ts` |
| Official Anthropic SDK and bounded tool loop | `server/agent.ts` |
| Browser-local revisions, receipts, comments and chat | `src/local-store.ts`, `src/local-api.ts` |
| Transient AI relay and deployment origin checks | `server/browser-app.ts`, `server/workspace-tools.ts` |
| Workspace backup/import | `shared/browser-storage.ts`, `src/local-store.ts` |

`read_context` returns the live revision, active slide, selection IDs, slide metadata, and requested node properties. `apply_batch` only accepts the enumerated operations in `shared/model.ts` and an `expectedRevision`. Newly created IDs are supplied by the model and checked for uniqueness.

The browser validates commands, captures a before-snapshot, applies the batch to the editor, and saves the snapshot, revision, affected comment anchors and receipt in one IndexedDB transaction. It acknowledges success only after that transaction completes. The relay validates the command/revision and the matching browser commit acknowledgement; it cannot independently verify browser storage. This is an intentional change from server-authoritative SQLite. Browser tabs use optimistic revisions to reject conflicting writes rather than silently merging them.

Failed batches restore the before-snapshot and return an error. Save retries reuse the exact payload and command ID; duplicate IDs with different content are rejected. Lost responses are reconciled against durable receipts. If the outcome cannot be determined, editing pauses until reload rather than pretending success. Concurrent/stale revisions return HTTP 409; reload to recover the latest durable deck. Already committed batches remain saved when cancelling; cancellation stops subsequent work, not completed changes.

Limits: 100 slides, 2,000 nodes, 100 operations per batch, 12 MiB request body, 30 tool calls, 30 seconds per browser command, 120 seconds per run. There is no separate model-round/iteration cap: the agent continues until it finishes, is cancelled, or reaches one of the remaining budgets. At most one AI run per deck (legacy API) or conversation (shared workspace). Runs are intentionally not resumed after a server/browser restart.

Current data lives in the **`pencil-workspace-v1` IndexedDB database**, scoped to the browser profile and site origin. Clearing that site's storage removes it. Workspace backups are JSON downloads made entirely in the browser. The relay never reads, creates or serves SQLite workspace files.

## SDK integration notes

OpenPencil `core`, `scene-graph`, and `vue` are pinned together at **0.15.0**; CanvasKit is pinned at **0.41.1**. The application uses `createEditor`, `provideEditor`, `useCanvas`, `useCanvasInput`, and `useTextEdit`; the canvas is not an SVG/DOM imitation. It uses the lower-level SDK canvas composable to avoid the published `CanvasRoot`/`CanvasSurface` nested-ref mount timing issue.

- `scripts/assets.mjs` copies the packages' CanvasKit WASM and bundled Inter/fallback fonts into ignored `public/` during install. No CDN is needed for normal editing. If install scripts were disabled, run `node scripts/assets.mjs`.
- The 0.15.0 package ships JavaScript workers but retains `.ts` URLs in three emitted clients. The narrowly scoped Vite plugin corrects those URLs without modifying `node_modules`. Explicit dependency prebundling also makes the SDK's CommonJS dependencies work in Vite development.
- The SDK text-input bridge expects utility CSS. The host supplies its hidden-textarea styling without requiring Tailwind.
- The build emits upstream browser-externalization warnings for guarded Node-only SDK paths and a large-bundle warning. These do not prevent the verified browser build from working.

## Tests and verification

The browser-local migration is covered by `tests/local-store.test.ts`, `tests/browser-app.test.ts`, and `tests/browser-chat.test.ts`: persistence and isolation, cross-tab revision conflicts, comment lifecycle/anchor mapping, atomic backup import, capability-protected run acknowledgements, hosted origin checks, and streamed transcript checkpoints. Legacy SQLite tests remain as historical regression coverage but do not describe the production storage path.

Fresh-context Playwright checks verify that independent browser profiles see different workspaces; AI-created documents/slides/pages and comments survive reload; no workspace-storage API calls are made; backups import into a second profile; and edits save while the network is disconnected after loading. The production-only runtime is also checked without dev dependencies or UI source files. A full Docker build requires a running Docker daemon.

```sh
npm test          # Node tests: real SDK graph/history, IndexedDB isolation/reopen,
                  # revision/idempotency, API origin guards, mocked streamed tools,
                  # generated PPTX ZIP/XML geometry, text, order, notes and fallback,
                  # comment lifecycle, detachment, geometry, browser receipts,
                  # explicit AI handoff, host/origin policy and workspace backup/import
npm run build    # Strict TS/Vue typecheck plus production bundle
```

A separate, deterministic provider can exercise the **actual editor → IndexedDB → AI relay acknowledgement** flow without a key:

```sh
npm run build
npx tsx tests/browser-server.ts
# Open http://127.0.0.1:3002; each browser profile has its own test workspace
```

This is a test-only entry point, never enabled by the normal server. Select a title and send any prompt: it creates a slide and changes that selected title in one atomic batch. Send `fail` to test partial-batch rollback, `conflict` to test stale-revision rejection, or `cancel` then Stop to test abort. Ctrl+C stops the test server.

The fixture also supports the shared workspace without an API key. Send **Create both a document and slides** to exercise creation, artifact switching, current-context reads, document/slide saves, and durable acknowledgements in one conversation. In an existing document, select text and send a normal request to replace that selection. Send **fail** for an invalid second document operation, **conflict** for a stale revision, and **cancel** then Stop for cancellation. `tests/documents.test.ts` covers schemas, range mapping, migration, idempotency and Word ZIP/XML; `tests/workspace.test.ts` covers the shared streamed protocol. These are deterministic provider tests, not live Anthropic calls.

The shared workspace was also exercised in Playwright: creating both artifact kinds in one streamed request, document formatting, title undo/redo, text comments and replies, resolve/reopen, draft switching guards, explicit comment handoff preserving the chat draft, replacement detachment surviving undo, rollback/cancellation, reload persistence, mobile layout, and actual Word/PowerPoint downloads. A downloaded Word file passed OOXML schema validation. Desktop Word rendering and live Anthropic requests are not part of these deterministic checks.

A separate live Anthropic smoke test through Playwright created and saved a short document and one-slide deck in one conversation, confirming provider acceptance of the published tool schemas and durable saves for both artifact types.

The isolated deterministic provider also supports **Create a page about Tokyo**. `tests/pages.test.ts` covers real SDK layout, nested graph restoration, topology validation, escaped HTML, API ownership and durable page saves. Page browser checks use a separate browser context and test database, not a live API credential.

Page Playwright checks verified a single updated artifact card, real canvas rendering, property-based text editing, undo/redo, Fill reflow at desktop and mobile widths, Fit preserving the 1200-pixel design width, readable HTML with no canvas or editable fields, returning to the canvas on mobile, actual HTML download, atomic failed-batch rollback, and reload persistence.

Page-comment browser checks cover nested object and section anchors, keyboard context-menu points, replies, resolve/reopen, draft switching guards, explicit AI handoff preserving the composer draft, permanent detachment after deletion/undo, and mobile keyboard placement below the old 1080-pixel slide boundary. Markdown checks exercise streamed headings/lists/tables/code, safe links, plain user messages, reload, and blocked script/image payloads. Run the deterministic browser fixture and send **markdown test** to reproduce the Markdown sample without an API key.

Playwright verification covered the real CanvasKit surface, text insertion/property edits, native double-click text editing, native rectangle drag/resize, save/reload, undo/redo, slide ordering, thumbnails, PNG download, and presentation image dimensions. The deterministic provider also exercised browser-side selected-text updates, atomic AI undo/redo, rollback, revision failures, cancellation, and persisted chat after restart. **No live Anthropic request was verified without a configured API key.**

PowerPoint verification includes actual browser downloads in editable, mixed-fallback, and exact-appearance modes. Downloaded ZIP/XML was checked for native text/shapes versus pictures, all-slide counts, and embedded 1920×1080 PNG dimensions. Unit tests additionally check metadata order, positions/sizes, typography/alignment, transparency, notes, unsupported-content detection, and failure handling. The rendered fallback image was visually inspected. Desktop PowerPoint/Keynote rendering was not automated; the font/reflow limitations above still apply.

Comment verification covers real point/object posting, replies, resolve/reopen and filtering, reload persistence, native object dragging with following pins, detached threads after deletion/undo, thread-to-slide navigation, Escape/keyboard placement, responsive mobile pinning, and mocked Claude handoff preserving the unrelated composer draft. Exported PNG/PPTX image pixels at a visible pin location were checked against the clean slide background; comment text was absent from PPTX XML, and presentation mode removed the pin overlay. Unit tests cover SQLite reopen/idempotency, validation, permanent detachment/ID reuse, nested transform math, and mandatory current-context reads before comment-driven AI changes.

Context-menu checks cover right-clicking a different object than the selection, background placement after pan/zoom, disabled outside-slide actions, viewport edge clamping, Shift+F10/Context Menu key, keyboard activation, Escape/outside-click focus handling, and native chat menus. Both object and point comments were posted through the real UI with the artwork revision and node count unchanged.

Selection-toolbar verification covers normal left-click and touch selection, pressed formatting states, font/color/alignment changes, outline/radius/size edits, undo/redo and reload, input drafts across redraws, keyboard Delete/Escape scoping, Comment/Properties focus, native dragging/resizing, multi-select hiding, context-menu/text-edit coexistence, and mobile placement. Export pixel/XML checks confirm the overlay does not enter PNG/PPTX output; presentation hides it. Unit tests cover supported selection types, transformed bounds and edge placement, rich-run preservation, validated shape styling, and durable history round-trips.

## Deliberate MVP boundaries

No authentication or collaborative editing. Browser profiles are independent; tabs on the same origin share local data and can encounter revision conflicts. Host/origin guards are not authentication. Public hosting still exposes the shared AI budget, as described in the Render section.

No collaboration, public hosting, generated/imported images, arbitrary OpenPencil/Figma import, rich theme system, speaker-notes editor, or cross-session undo history. Slides support text and basic shapes only. Slide fonts use the SDK's bundled Inter; this is not a general font-management UI. Large decks can be slower because persistence uses full snapshots and thumbnails use actual raster rendering. Rich-text document boundaries are listed above.
