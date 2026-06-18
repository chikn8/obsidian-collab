# Releases, Auto-Updates, and Mobile

## Auto-update model

Obsidian's native update path is release based. A plugin version is defined by
`manifest.json`; `versions.json` maps that plugin version to the minimum Obsidian version; and the
GitHub release tag must be the exact version string, with release assets named `main.js`,
`manifest.json`, and `styles.css`.

This repo already matches that shape:

- `plugin/manifest.json`, `plugin/package.json`, and root `versions.json` are checked by
  `plugin/test/release-metadata.test.mjs`.
- `.github/workflows/release-plugin.yml` runs plugin tests/build and publishes those three release
  assets when a `*.*.*` tag is pushed.
- Public Community Plugin listing is still the only normal Obsidian auto-update path for ordinary
  users.

For private friend testing, use BRAT. Friends install BRAT once, add this GitHub repo, then BRAT pulls
release assets from GitHub releases and reloads the plugin. That avoids copying files manually, but it is
still a beta/private channel, not Obsidian's built-in Community Plugin updater.

Manual installs do not auto-update. If `.obsidian/plugins/live-collab` is excluded from Obsidian
Sync, every device needs either BRAT, a public Community Plugin install, or a manual file copy.

Do not add a silent self-updater to this plugin. A self-modifying collaboration plugin would bypass the
trust boundary users expect from Obsidian/BRAT release installs, and it is harder to reason about on
mobile. If private updates ever need to be smoother than BRAT, make it an explicit "Check for plugin
update" command that shows the target version and asks before writing plugin files.

## Release checklist

1. Update `plugin/manifest.json` and `plugin/package.json` to the same `x.y.z` version.
2. Add `"x.y.z": "<minAppVersion>"` to root `versions.json`.
3. Run `cd plugin && npm test && npm run build`.
4. Commit the version bump.
5. Tag with the exact version, for example `git tag 0.1.2`.
6. Push the commit and tag. The release workflow will attach `main.js`, `manifest.json`, and
   `styles.css`.
7. For BRAT users, tell them to check for plugin updates after the release exists.

## Public listing status

The plugin id is `live-collab`, which avoids the public Community Plugin directory restriction against
ids containing `obsidian`. Existing manual installs that used `.obsidian/plugins/obsidian-collab` should
install future builds in `.obsidian/plugins/live-collab`; if the new plugin data file is empty, startup
imports the old `obsidian-collab/data.json` settings once and then saves them under the new id.

Public listing also means being explicit about security and network behavior:

- The plugin sends note text, comments, filenames, awareness, and attachment blobs to the configured
  relay server for selected shared folders.
- The relay should be operated with strong secrets, per-share links, persistent storage, off-box
  snapshots/backups, and audit logs.
- `SERVER_SECRET` must stay server-side. Normal clients use share keys/invites minted by the server.

## Mobile support status

`plugin/manifest.json` has `isDesktopOnly:false`, and the release metadata test locks that in. The plugin
avoids top-level Node/Electron APIs and uses Obsidian's `requestUrl` wrapper for HTTP, which is the mobile
safe path.

Expected to work on mobile:

- Text sync through Yjs/WebSocket.
- Offline local Yjs persistence through IndexedDB.
- Editor cursors, selections, self-selection overlay, and in-editor facepile. The bound editor advertises
  the current device immediately so the self avatar is visible even before typing.
- Comments and version-history HTTP calls.
- Binary attachment upload/download through Obsidian HTTP APIs, subject to mobile memory/network limits.
- Multi-device presence: each phone/tablet/desktop install has its own `deviceId`, color variant, and
  awareness entry. Editor cursors, self-selection overlays, file-tree badges, tab badges, and facepiles
  use the same device color. Cursor labels include the device, while facepiles and hover labels show the
  plain name plus device/status. Mention autocomplete groups live same-name devices into one visible row
  and fans the notification out to all live device identities behind that name.

Known mobile differences:

- File-explorer and tab-header badges are opportunistic on mobile. The renderer now runs on every
  platform, but Obsidian mobile uses different navigation drawers across app versions; if compatible
  `.nav-file-title` / `.workspace-tab-header` anchors are not present, the in-editor facepile remains the
  reliable presence surface.
- Background execution is not guaranteed. If the mobile app is suspended, live WebSocket presence and
  sync resume when Obsidian is foregrounded again. Before hide/page-unload events, the plugin forces the
  active editor's current Yjs text to disk so the latest bound-editor state is not waiting on a debounce.
- OS-level push notifications are not provided by Obsidian plugins. The existing ntfy path is external.

The practical mobile test matrix is still human: iOS and Android, one desktop peer, one phone peer,
foreground/background transitions, attachment sync, comments, and conflict recovery.

## References

- Obsidian sample plugin release flow:
  <https://github.com/obsidianmd/obsidian-sample-plugin#releasing-new-releases>
- Obsidian manifest fields and plugin id constraints:
  <https://docs.obsidian.md/Reference/Manifest>
- Obsidian mobile/plugin checklist:
  <https://docs.obsidian.md/oo/plugin>
- BRAT developer notes:
  <https://tfthacker.com/brat-developers>
