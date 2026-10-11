# Cloud File Manager

The desktop half of the Cloud File Manager plugin for Hermes
([`electricsheephq/hermes-cloud-file-manager`](https://github.com/electricsheephq/hermes-cloud-file-manager)), bundled so
that evaOS agents running the plugin's gateway half get **Cloud Files**:
- browse, search and create folders in the agent's workspace;
- upload files and whole folders;
- open and edit Markdown and text files with an explicit Save;
- import files from the agent's Google Drive;
- **+ → Cloud** in the chat composer, which hands the agent file locations without re-uploading.

## Availability

The plugin is on by default, but it shows nothing until the selected agent's gateway answers
`/api/plugins/hermes-cloud-file-manager/available`. Agents without the gateway plugin get no sidebar row and no
**+ → Cloud** entry. The plugin re-probes when the agent changes and every 60 s. A 404 removes the row and the composer
entries; a transport error keeps the last answer. The `/cloud-files` route itself is always registered, so a restored
tab never falls through to the session route.

On evaOS, the gateway half is the managed `hermes-cloud-file-manager` plugin that PCS installs from its pin
(`manifests/hermes-cloud-file-manager-<version>.v1.json`). Its root is the agent's workspace (`terminal.cwd`).

## Provenance and updates

`plugin.js` is the plugin's committed build, copied byte for byte:

| | |
|---|---|
| Release | v0.3.5 (`173962fb144d3de446c0784b189adca346e5cffe`) |
| File | `desktop/plugin.js` |
| sha256 | `2b7d42cb510643584e09caab2196af3ead0049f80f1cafc6ed71c285071a0ea0` |
| License | MIT (`LICENSE`) |

It imports only `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`. The app build fails if it imports a name this
app's SDK no longer exports, and `src/contrib/vendored-plugins.test.ts` registers it through the real plugin lifecycle.

To update it:
1. Copy `desktop/plugin.js` from the new release tag.
2. Update this table.
3. Run the desktop tests.

Never edit the file here. Ship it in the same app release as, or after, the gateway-half pin it needs. The plugin hides
any feature that an older gateway half answers with 404.
