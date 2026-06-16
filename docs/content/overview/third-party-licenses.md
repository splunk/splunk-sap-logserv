# Third-Party Software Licenses

Splunk for SAP LogServ bundles open-source software from the npm ecosystem (the React-based LogServ UI App is a webpack-built single-page application). Each component carries its own license, and per those licenses we preserve attribution and bundle the full license text alongside the App.

## Where to find the full notices

The complete list of bundled third-party packages — names, versions, declared licenses, and full license text — is delivered in two places:

- **Inside the App tarball** — `splunk_app_sap_logserv/THIRD-PARTY-NOTICES.md` (the file is at the root of the installed app directory after extraction)
- **At the source-tree root** — the same file lives at the root of the GitHub release source tarball

The file is generated deterministically from the resolved `node_modules/` tree at build time, so its content matches exactly what shipped with the App version you have installed.

## License-distribution summary (v0.0.6.0)

The v0.0.6.0 build includes **1236 unique top-level packages** under `node_modules/`. The license breakdown:

| License (SPDX as declared) | Count | Inclusion obligation |
|---|---:|---|
| MIT | 1012 | Copyright + license text (preserved in `THIRD-PARTY-NOTICES.md`) |
| ISC | 64 | Copyright + license text |
| Apache-2.0 | 57 | License text + NOTICE if present |
| BSD-3-Clause | 46 | Copyright + license text |
| BSD-2-Clause | 22 | Copyright + license text |
| `SEE LICENSE IN LICENSE.md` (Splunk libs) | 11 | Covered as a Splunk Extension under §1.C of Splunk General Terms |
| BlueOak-1.0.0 | 4 | License text |
| CC0-1.0 / 0BSD / MIT-0 | 7 | Public-domain or near-public-domain (no obligation) |
| BSD-3-Clause AND Apache-2.0 | 1 | License text |
| MIT AND Zlib | 1 | License text |
| MIT OR Apache-2.0 | 1 | Either license; we attribute MIT |
| MIT OR CC0-1.0 | 1 | Either license; we attribute MIT |
| MPL-2.0 OR Apache-2.0 | 1 | We do not modify the file; either license is satisfied |
| MIT OR SEE LICENSE IN FEEL-FREE.md | 1 | MIT chosen |
| MPL-2.0 (axe-core) | 1 | License text only (we do not modify the source) |
| EPL-2.0 (elkjs) | 1 | License text only — file-level weak copyleft; we bundle the package unmodified |
| Python-2.0 | 1 | License text |
| CC-BY-4.0 / CC-BY-3.0 | 2 | Attribution preserved |
| (no declared license field) | 2 | See note below |

### Notes

- **No GPL/AGPL/LGPL components** are included in the App. The license posture is fully compatible with commercial redistribution under the standard Splunkbase model.
- **Two file-level weak-copyleft components** — `axe-core` (MPL-2.0) and `elkjs` (EPL-2.0, the Environment Topology layout engine) — are bundled **unmodified**. Both MPL-2.0 and EPL-2.0 are file-scoped copyleft (not project-scoped like GPL), and their obligations are satisfied by preserving the license text and not modifying the source, which we do. Neither is in the GPL/AGPL/LGPL family.
- **Two packages without a declared `license` field** — `@mapbox/jsonlint-lines-primitives@2.0.2` and `uuid-v4@0.1.0` — are present as transitive dependencies. Both are de-facto open-source and have been on the public npm registry for years; reviewers preparing legal attestations should consult the upstream repositories listed in the per-component entries of `THIRD-PARTY-NOTICES.md` for any final disposition.
- **`@splunk/*` packages** (11 total, declared as `SEE LICENSE IN LICENSE.md`) are covered as a Splunk Extension under §1.C of the Splunk General Terms — the standard mechanism for redistributing Splunk UI libraries inside a Splunkbase-distributed app.

## Refresh policy

The `THIRD-PARTY-NOTICES.md` file is regenerated from the resolved `node_modules/` tree at every release. v0.0.5.0 used a one-off generation pass; v0.0.6.0 and later auto-refresh the file as part of the standard `yarn build` pipeline (`bin/generate-third-party-notices.js`, run after the webpack output lands in `stage/`) so the notices and the bundled JavaScript artifacts always agree on what was shipped.
