# Third-Party Software Licenses

Splunk for SAP LogServ bundles open-source software from the npm ecosystem (the React-based LogServ UI App is a webpack-built single-page application). Each component carries its own license, and per those licenses we preserve attribution and bundle the full license text alongside the App.

## Where to find the full notices

The complete list of bundled third-party packages — names, versions, declared licenses, and full license text — is delivered in two places:

- **Inside the App tarball** — `splunk_app_sap_logserv/THIRD-PARTY-NOTICES.md` (the file is at the root of the installed app directory after extraction)
- **At the source-tree root** — the same file lives at the root of the GitHub release source tarball

The file is generated deterministically from the resolved workspace `node_modules/` tree at build time, so every package resolved into that tree is listed at the version that was bundled with the App you have installed.

## License-distribution summary (v0.1.2)

The v0.1.2 build includes **1236 unique top-level packages** under `node_modules/` (see the Summary block at the top of the shipped `THIRD-PARTY-NOTICES.md` for the authoritative figures). The license breakdown:

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

- **No GPL/AGPL/LGPL components** are included in the App's npm dependency tree. The npm license posture is fully compatible with commercial redistribution under the standard Splunkbase model.
- **Two file-level weak-copyleft components** — `axe-core` (MPL-2.0) and `elkjs` (EPL-2.0, the Environment Topology layout engine) — are bundled **unmodified**. Both MPL-2.0 and EPL-2.0 are file-scoped copyleft (not project-scoped like GPL), and their obligations are satisfied by preserving the license text and not modifying the source, which we do. Neither is in the GPL/AGPL/LGPL family. (The elkjs entry joined the generated notices in App build 333, when the package's formal dependency declaration was added.)
- **Two packages without a declared `license` field** — `@mapbox/jsonlint-lines-primitives@2.0.2` and `uuid-v4@0.1.0` — are present as transitive dependencies. Both are de-facto open-source and have been on the public npm registry for years; reviewers preparing legal attestations should consult the upstream repositories listed in the per-component entries of `THIRD-PARTY-NOTICES.md` for any final disposition.
- **`@splunk/*` packages** (11 total, declared as `SEE LICENSE IN LICENSE.md`) are covered as a Splunk Extension under §1.C of the Splunk General Terms — the standard mechanism for redistributing Splunk UI libraries inside a Splunkbase-distributed app.

### Bundled fonts

Beyond npm packages, the App bundles three font families (listed in the shipped notices file's "Bundled fonts" section): **Inter** (SIL Open Font License 1.1), **Roboto Mono** (Apache-2.0), and **Sharp Sans** (a commercial typeface used under Cisco's license — not open source; do not extract or reuse it outside this App).

### Scope

The sections above cover the **LogServ UI App's** npm dependencies and bundled fonts. The add-ons' Python packages follow.

## Python packages in the add-ons

The Data TA and the Azure and GCP ingest add-ons bundle the same nine Python packages, at the same versions, in their `lib/` folder; Splunk's UCC build framework installs them. Each package's own license file ships beside it, in `lib/<package>-<version>.dist-info/`.

| Package | Version | License (SPDX) |
|---|---|---|
| defusedxml | 0.7.1 | PSF-2.0 |
| deprecation | 2.1.0 | Apache-2.0 |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause |
| PySocks | 1.7.1 | BSD-3-Clause |
| solnlib | 7.0.0 | Apache-2.0 |
| sortedcontainers | 2.4.0 | Apache-2.0 |
| splunk-sdk | 2.1.1 | Apache-2.0 (the package ships no license file; the notices file below carries the text) |
| splunktaucclib | 8.2.0 | Apache-2.0 |
| urllib3 | 1.26.20 | MIT |

- **`requests` and `splunk` are not bundled.** The packages above import them from the Splunk platform's own Python at run time.
- **The Data TA's notices file.** Since build 1792189743 the Data TA ships `THIRD-PARTY-NOTICES.md` at the root of the add-on, naming these packages, the vendored files inside them (two copies of `six`, urllib3's backports) and the Apache License 2.0 text, and its `lib/requirements.txt` pins each package's exact version with its PyPI file hashes, so a rebuild cannot pick up a newer release unseen.
- **The add-ons' configuration pages** are compiled by UCC and carry their own notice file for the npm packages they contain: `appserver/static/js/build/licenses.txt` in each add-on.

## Known advisories: urllib3 1.26.20

The Data TA, the Azure and GCP ingest add-ons and the Demo Data Generator TA bundle urllib3 1.26.20, which
vulnerability scanners report as affected by seven advisories: CVE-2025-50181, CVE-2025-66418, CVE-2025-66471,
CVE-2026-21441, CVE-2026-44431, CVE-2026-97687 and CVE-2026-97689. We analysed each against the add-ons' code, and none
affects them as shipped:

- **No add-on code uses urllib3.** It is loaded only by Splunk's solutions library (solnlib), whose REST client talks
  to the local splunkd management port (by default `127.0.0.1:8089`) with the add-on's own session key. The add-ons'
  outbound connections (Azure Storage, the Google Cloud APIs and the Demo Data Generator's HTTP Event Collector
  sender) use Python's standard library, and no script in the Data, Azure or GCP add-ons imports `requests` or
  `urllib3`, directly or through `splunk_aoblib`.
- **Three need code paths that are never taken** - urllib3's redirect handling with retries turned off, following
  redirects while streaming a response, and passing credentials on across redirects through a proxy:
  CVE-2025-50181, CVE-2026-21441 and CVE-2026-44431.
- **Three need a malicious server on the splunkd management port** - decompression and chunked-response attacks:
  CVE-2025-66418, CVE-2025-66471 and CVE-2026-97689. With the default `mgmtHostPort` that is the loopback interface,
  so an attacker would already need access to the host; if you bind the management port to a network address, the
  protection rests on that network.
- **One needs an HTTPS proxy in splunkd's environment** - CVE-2026-97687. If splunkd's environment sets `HTTPS_PROXY`,
  also set `NO_PROXY=127.0.0.1,localhost` (see [Installing the Data TA](../install-setup/install-ta.md)).

**Why the add-ons do not ship urllib3 2.x.** urllib3 2.x requires OpenSSL 1.1.1 or later, and the Python in Splunk
Enterprise 9.4.3 is built with OpenSSL 1.0.2 (`OpenSSL 1.0.2zl-fips` on our test systems), so urllib3 2.x cannot load
there. The releases that fix the newest advisories also require Python 3.10 or later, while Splunk 9.4 runs Python
3.9, and the current splunktaucclib release requires `urllib3<2`. Splunk Enterprise 9.4.3's own Python includes
urllib3 1.26.19. We expect to stop bundling urllib3, or to move to a 2.x release, when the add-ons' minimum supported
Splunk version moves past 9.4.

## Refresh policy

The `THIRD-PARTY-NOTICES.md` file is regenerated from the resolved `node_modules/` tree at every release. v0.0.5.0 used a one-off generation pass; v0.0.6 and every later release (including v0.1.1 and v0.1.2) auto-refresh the file as part of the standard `yarn build` pipeline (`bin/generate-third-party-notices.js`, run after the webpack output lands in `stage/`) so the notices and the bundled JavaScript artifacts always agree on what was shipped.
