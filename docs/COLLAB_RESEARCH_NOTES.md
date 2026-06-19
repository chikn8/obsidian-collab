# Collaboration research notes

Practical background for the "why is Google Docs good?" / "what can we steal?" questions.

## Source audit, 2026-06-19

Primary and near-primary sources still point to the same architecture:

- Google's public writeup of the 2010 Docs editor names operational transformation plus a collaboration
  protocol as the core of fast concurrent editing, not UI scraping.
- Neil Fraser's Google Research paper on Differential Synchronization is useful background for robust
  state convergence, but the current project should not switch to full-file diff sync because Yjs already
  gives us operation-level CRDT updates for text.
- Yjs documentation describes shared types that merge concurrent edits automatically, and awareness as a
  separate CRDT for transient cursor/presence state.
- Hocuspocus is the closest mature open-source shape to study if this server needs a larger rewrite: Yjs
  sync, awareness, persistence hooks, auth hooks, and Redis-style scale-out are its key ideas. We should
  borrow architecture ideas, not add it as a dependency unless the current custom relay becomes a liability.
- Obsidian's release model remains GitHub-release based for normal users; public Community Plugin listing
  is the native update channel, while BRAT is the practical private beta path.

## What mature editors do

Google Docs-class collaboration is not polling the rendered UI. The core is an operation stream over a
shared document model, plus separate ephemeral presence:

- document edits are operations that merge deterministically;
- cursor/selection/typing state is awareness/presence and can be dropped without corrupting content;
- offline state is local-first: local edits are kept locally and replayed/merged on reconnect;
- filesystem/storage is treated as a persistence layer, not as the source of collaborative truth.

This project is already aligned with that shape for text files:

- per-file Yjs docs hold Markdown/Canvas text and comments;
- active editors bind directly to Yjs through CodeMirror/yCollab;
- background files sync headlessly through `FileProvider`;
- presence is awareness state, separate from document content;
- the manifest owns file lifecycle events (create/delete/rename/blob metadata).

The unstable parts now are mostly around systems outside the CRDT: Obsidian DOM anchors, mobile lifecycle,
binary attachments, deployment durability, true account/login recovery, and production scale-out.

## Open-source pieces worth using

- **Yjs** is the right fit for the current editor layer. Its docs model collaboration as a shared `Y.Doc`
  synchronized by providers, with awareness used for presence/cursors. This matches the current split between
  content sync and UI presence.
- **Automerge** is a strong local-first CRDT system, especially for structured app data. It is not an obvious
  replacement for the current text stack because the current CodeMirror/Yjs binding already solves live text
  editing, cursors, and offline merge. Automerge ideas still matter for future account/ACL/local-first design.
- **CodeMirror itself does not provide peer cursors by default**; cursor/selection sharing must be implemented
  via collaboration/presence layers. Using yCollab/Yjs awareness is therefore the right architectural move.
- **Hocuspocus** is worth studying before a server rewrite. Its shape validates the next big architectural
  direction if needed: keep Yjs as the document model, add persistence/auth hooks cleanly, and use a shared
  fan-out layer for horizontal scale.

## Obsidian plugin releases and mobile

Obsidian plugin distribution is GitHub-release based for community plugins. Release tags must line up with the
version in `manifest.json`; Obsidian downloads `manifest.json`, `main.js`, and `styles.css`. `versions.json`
only needs updates when the minimum supported Obsidian app version changes.

For mobile, the official support switch is `isDesktopOnly`. Setting it to `false` makes the plugin installable
on mobile, but it does not make desktop-only APIs or DOM assumptions safe. This plugin should keep avoiding
Node/Electron-only APIs in client code, use Obsidian/request-compatible HTTP APIs, and treat file-tree/tab DOM
badges as opportunistic. The in-editor CodeMirror facepile remains the reliable cross-platform surface.

## Current project takeaways

- Do not replace Yjs with polling or full-file scraping. The architecture should continue moving toward
  operation/event streams and away from filesystem timing as a source of truth.
- Keep presence self-visible. It is the cheapest way to test what collaborators see without a second device.
- Keep tab/file-tree badges as a best-effort enhancement, not the only presence UI.
- Binary files cannot CRDT-merge like text. Visible conflict copies are the right recovery primitive until a
  richer review UI exists.
- The biggest non-code trust gate is still ops: Railway persistence, off-box backups, and ops alerting must
  be configured and verified.
- Do not add a silent self-updater. Use public Community Plugin updates when public, and BRAT/GitHub releases
  for private friend testing.

## Sources

- Obsidian Developer Docs, Versions: <https://docs.obsidian.md/Reference/Versions>
- Obsidian Developer Docs, PluginManifest.isDesktopOnly: <https://docs.obsidian.md/Reference/TypeScript%2BAPI/PluginManifest/isDesktopOnly>
- Obsidian Developer Docs, Mobile development: <https://docs.obsidian.md/Plugins/Getting%2Bstarted/Mobile%2Bdevelopment>
- Obsidian releases community plugin repository: <https://github.com/obsidianmd/obsidian-releases>
- Google Docs blog, "What's different about the new Google Docs: Making collaboration fast": <https://drive.googleblog.com/2010/09/whats-different-about-new-google-docs.html>
- Neil Fraser, Differential Synchronization: <https://research.google.com/pubs/archive/35605.pdf>
- Yjs Docs, Introduction: <https://docs.yjs.dev/>
- Yjs Docs, Collaborative editor: <https://docs.yjs.dev/getting-started/a-collaborative-editor>
- Yjs Docs, Awareness & Presence: <https://docs.yjs.dev/getting-started/adding-awareness>
- Yjs Docs, Awareness API: <https://docs.yjs.dev/api/about-awareness>
- Automerge Docs: <https://automerge.org/docs/hello/>
- Hocuspocus Docs, Overview: <https://tiptap.dev/docs/hocuspocus/getting-started/overview>
- CodeMirror discussion on peer cursors: <https://discuss.codemirror.net/t/how-to-show-peers-cursors-on-cm6-collab-editor/3996>
