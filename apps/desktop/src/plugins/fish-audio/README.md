# Fish Audio

The desktop half of the Fish Audio plugin for Hermes
([`100yenadmin/fish-audio-hermes`](https://github.com/100yenadmin/fish-audio-hermes)), bundled so that evaOS agents
running the plugin's gateway half get the **Voices** page:
- search the voice library, preview a voice, and **Use** it for the next reply;
- your own voices: clone and design them;
- the account balance, plus a credit chip in the status bar;
- palette commands.

## Availability

The plugin is on by default, but it shows nothing until the selected agent's gateway answers
`/api/plugins/fish-audio/available`. Agents without the gateway plugin get no sidebar row, chip or palette entries. When
the agent changes, the previous agent's entries go away at once and return only if the new agent answers; it also
re-probes every 60 s. The Voices route itself is always registered, so a restored
`/fish-audio` tab never falls through to the session route.

On evaOS, the gateway half is the managed `fish-audio` plugin that PCS installs alongside the `evaos-fishaudio` voice
provider (PCS 0.1.166). **Use** writes the voice to the profile layer, where the managed overlay never sets it.

## Provenance and updates

`plugin.js` is the plugin's committed build, copied byte for byte:

| | |
|---|---|
| Release | v1.0.3 (`79ff92b51bc8c7cc502ec21f2ca8974dbb3c73c9`) |
| File | `desktop/plugin.js` |
| sha256 | `c87b6c0e1540ab50961ae54d942cc7985b047cba24a318da456b20ce9617f9ac` |
| License | Apache-2.0 (`LICENSE`) |

It imports only `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`. Every SDK name it imports is exported by this
app's `src/sdk/index.ts`, which the plugin's `scripts/check-sdk-exports.mjs` checks.

To update it:
1. Copy `desktop/plugin.js` from the new release tag.
2. Update this table.
3. Re-run that check against `src/sdk/index.ts`.

Never edit the file here.

For development, the same plain-ESM file can load through the runtime door at
`$HERMES_HOME/desktop-plugins/fish-audio/plugin.js`. When both exist, the bundled copy wins.
