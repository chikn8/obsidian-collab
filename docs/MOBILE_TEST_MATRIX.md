# Mobile and Two-Person Test Matrix

Run this before trusting a release with important notes. Use one desktop peer and at least one mobile peer.
If possible, repeat the mobile pass on both iOS and Android.

## Setup

- Exclude the shared folder from Obsidian Sync on every device.
- Install the same plugin release on every device, preferably through BRAT or the public release channel.
- Confirm `node tools/prod-health-check.mjs` passes for the relay before starting the data-loss tests.
- Create one fresh test share and one invite with `Max devices` set to `2`.
- Join from desktop and phone with the same invite, then confirm both devices appear as separate same-name
  presence entries with different colors.

## Text Sync

- Desktop creates `mobile-test.md`; phone receives it.
- Phone types a paragraph while desktop watches; desktop receives it without reload.
- Desktop types while phone watches; phone receives it without reload.
- Phone types, immediately switches to another note, then switches back; the typed text is still present
  locally and on desktop.
- Put the phone in the background for 30 seconds, foreground it, type again, and confirm desktop converges.
- Turn phone network off, edit the note, then reconnect; both offline and desktop edits survive.

## Presence

- Confirm your own avatar, own caret label, and own selection highlight are visible when testing alone.
- Confirm desktop sees the phone cursor/selection and phone sees the desktop cursor/selection.
- Confirm typing dots appear on the avatar without resizing the file-tree or tab row.
- Confirm file-tree badges have spacing after the note title.
- Confirm tab badges appear when the tab header exists. If mobile does not expose a compatible tab header,
  confirm the in-editor facepile still appears.
- Hover or long-press where supported and confirm labels show name plus device/status.

## File Lifecycle

- Rename a note on desktop; phone sees the renamed note with content intact.
- Move a folder containing at least two synced notes; the other device sees the folder move without duplicate
  ghost files.
- Delete a note on phone; desktop sees it removed and the deleted-file recovery list can restore it.
- Edit a note on one device while the other deletes it near the same time; confirm a visible delete-conflict
  copy is created instead of silent data loss.

## Comments and Mentions

- Add a comment on selected text from desktop; phone sees the comment and highlight.
- Reply from phone; desktop sees unread activity.
- Mention the same visible user name while that user has two devices connected; confirm one completion row
  fans out to both live device identities.

## Attachments

- Add a small image from desktop; phone downloads and displays it.
- Add a PDF or audio/video file from phone if the mobile OS picker allows it; desktop downloads it.
- Edit/replace the same attachment on both devices near the same time; confirm the conflict copy appears in
  version history/conflict review.

## Release Result

Save the result as JSON using [mobile-test-result.example.json](mobile-test-result.example.json) as the
template, then validate it:

```bash
node tools/mobile-matrix-check.mjs docs/mobile-test-result.example.json
node tools/release-readiness.mjs --mobile-result=<your-result.json>
```

Record failures with exported diagnostic bundle paths in the `failures` / `diagnosticBundles` fields.
