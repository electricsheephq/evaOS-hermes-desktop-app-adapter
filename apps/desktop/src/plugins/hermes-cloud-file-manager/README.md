# Cloud File Manager

The desktop half of the Cloud File Manager plugin for Hermes
([`electricsheephq/hermes-cloud-file-manager`](https://github.com/electricsheephq/hermes-cloud-file-manager)), bundled so
that evaOS agents running the plugin's gateway half get **Cloud Files**:
- browse, search and create folders in the agent's workspace;
- upload files and whole folders;
- open and edit Markdown and text files with an explicit Save;
- read-only previews of images, PDFs and code or data files (CSV as a table), with Retry on a failed preview; these
  need a 0.4.1 or newer gateway half, and an older one says previews need Cloud Files 0.4.1 or newer;
- drag files and folders into a chat as `@file:` / `@folder:` chips, or use **Add to chat** (the keyboard equivalent);
- **Show** on a finished upload, and Drive imports that land in the open folder;
- a file list that follows what the agent writes, without a Refresh;
- download one file at a time through this app's own authenticated download (`captureGatewayFileDownload`, the
  gateway's `/api/files/download`), from the toolbar or while viewing a file;
- import files from the agent's Google Drive;
- **+ → Cloud** in the chat composer, which hands the agent file locations without re-uploading.

The file list and the Drive picker work from the keyboard (one tab stop; arrows, Home/End, Page Up/Down, Enter, Space,
Alt+Up or Backspace), and the file list announces item counts, search results and load errors to screen readers.

## Availability

The plugin is on by default, but it shows nothing until the selected agent's gateway answers
`/api/plugins/hermes-cloud-file-manager/available`. Agents without the gateway plugin get no sidebar row and no
**+ → Cloud** entry. The plugin re-probes when the agent changes and every 60 s. On an agent change the row and
**+ → Cloud** go away until the new agent answers. An open picker stays, pinned to its agent: while the new agent's
answer is pending it waits and asks that agent nothing, and if the new agent has no Cloud Files (or no Google Drive) it
says so and offers to switch back. A Drive import already started resumes on switching back. The picker names the agent
whose files it shows; if that agent can't be reached it says so and offers **Retry**. It closes only when you
close it or its own agent answers 404. A 404 removes the row and
the composer entries; a transport error keeps the last answer for the same agent. The `/cloud-files` route itself is
always registered, so a restored tab never falls through to the session route; it waits for the answer before asking
the agent for anything.

On evaOS, the gateway half is the managed `hermes-cloud-file-manager` plugin that PCS installs from its pin
(`manifests/hermes-cloud-file-manager-<version>.v1.json`). Its root is the agent's workspace (`terminal.cwd`).

## Provenance and updates

`plugin.js` is the plugin's committed build, copied byte for byte:

| | |
|---|---|
| Release | v0.4.5 (`1f49fbb0867b74ad29cf9de52cfe8d9995591fae`); the desktop bundle is unchanged from v0.4.4 |
| File | `desktop/plugin.js` |
| sha256 | `1b13b64964500d17b765fa23c8154d3a1b44a754f42a16828f066c17e083e874` |
| License | MIT (`LICENSE`) |

It imports only `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`. The app build fails if it imports a name this
app's SDK no longer exports, and `src/contrib/vendored-plugins.test.ts` registers it through the real plugin lifecycle.
Download is the exception: the plugin looks up `captureGatewayFileDownload` on the SDK namespace, so if this app's SDK
stops exporting it, Download disappears and nothing else breaks.

To update it:
1. Copy `desktop/plugin.js` from the new release tag.
2. Update this table.
3. Run the desktop tests.

Never edit the file here. Ship it in the same app release as, or after, the gateway-half pin it needs. The plugin hides
any feature that an older gateway half answers with 404.
