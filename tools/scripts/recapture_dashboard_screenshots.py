#!/usr/bin/env python3
"""
Recapture full-page screenshots of every LogServ dashboard against splunk-sh-idxr.

Output: PNGs in docs/images/ with the canonical filenames (overwrites in place).

Usage:
    # put credentials in a .env file outside the snapshot dir (e.g. project root):
    #   SPLUNK_ADMIN_PASS=<password>
    # then either set ENV_FILE or accept the default lookup path below.

    # install playwright once (per machine)
    pip install playwright
    playwright install chromium

    # single-dashboard test
    python recapture_dashboard_screenshots.py --only dashboard-environment-health.png

    # full run (all 24 PNGs)
    python recapture_dashboard_screenshots.py

    # override the splunk URL if the EC2 public IP has changed
    python recapture_dashboard_screenshots.py --splunk-url http://NEW.IP:8000

Environment variables:
    SPLUNK_URL          default http://3.136.169.21:8000 (splunk-sh-idxr public IP)
    SPLUNK_USER         default 'admin'
    SPLUNK_ADMIN_PASS   required (or set in .env)
    ENV_FILE            path to .env (default: C:/ai_projects/logserv_comp/.env)
    HEADLESS            '1' (default) for headless, '0' to watch the browser
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from typing import Optional

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeout, sync_playwright

# ----- configuration -------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = REPO_ROOT / "docs" / "images"

APP_HOME = "/en-US/app/splunk_app_sap_logserv/home"
TIME_QS = "earliest=-30d%40d&latest=now"   # Last 30 days

# (filename, react path, optional tab label for multi-tab dashboards)
DASHBOARDS: list[tuple[str, str, Optional[str]]] = [
    ("dashboard-environment-health.png",        "/",                                None),
    ("dashboard-environment-topology.png",      "/topology/integration-topology",   None),

    ("dashboard-abap-security.png",             "/applications/abap-security",      None),
    ("dashboard-abap-operations.png",           "/applications/abap-operations",    None),
    ("dashboard-work-process-performance.png",  "/applications/work-process-performance", None),
    ("dashboard-hana-audit.png",                "/applications/hana-audit",         None),
    ("dashboard-hana-trace.png",                "/applications/hana-trace",         None),

    ("dashboard-sap-services.png",              "/integration/sap-services",        None),
    ("dashboard-sap-router.png",                "/integration/sap-router",          None),
    ("dashboard-cloud-connector.png",           "/integration/cloud-connector",     None),
    ("dashboard-web-dispatcher.png",            "/integration/web-dispatcher",      None),
    ("dashboard-web-api-performance.png",       "/integration/web-api-performance", None),

    ("dashboard-network-perimeter.png",         "/security/network-perimeter",      None),
    ("dashboard-cross-stack-authentication.png","/security/cross-stack-authentication", None),
    ("dashboard-change-config.png",             "/security/change-config",          None),

    # Data Pipeline Overview — 2 tabs (tab 2 is the source-to-sourcetype link graph)
    ("dashboard-overview.png",                  "/platform/data-pipeline-overview", "Overview"),
    ("dashboard-overview-2.png",                "/platform/data-pipeline-overview", "Sourcetype Mapping"),

    ("dashboard-dns-analytics.png",             "/platform/dns-analytics",          None),
    ("dashboard-linux.png",                     "/platform/linux",                  None),
    ("dashboard-windows.png",                   "/platform/windows",                None),
    ("dashboard-proxy.png",                     "/platform/proxy",                  None),

    # Host Details — 3 tabs
    ("dashboard-host-details-overview.png",     "/platform/host-details",           "Overview"),
    ("dashboard-host-details-role-activity.png","/platform/host-details",           "Role Activity"),
    ("dashboard-host-details-sourcetypes.png",  "/platform/host-details",           "Sourcetype Mapping"),
]

VIEWPORT = {"width": 1920, "height": 1080}
NAV_TIMEOUT_MS = 60_000
NETWORK_IDLE_MS = 60_000

# Wait-for-load configuration:
# We use a STABILITY-based check: take a DOM fingerprint every POLL_INTERVAL_S
# seconds; when the fingerprint hasn't changed for STABLE_FOR_S consecutive
# seconds we consider the page loaded. Hard ceiling at DATA_LOAD_TIMEOUT_S.
POLL_INTERVAL_S = 1.5
STABLE_FOR_S = 8           # require 8s of no DOM changes
DATA_LOAD_TIMEOUT_S = 120  # hard ceiling per dashboard
EXTRA_SETTLE_S = 3         # tiny post-stability settle for chart-tween paint
TAB_SETTLE_S = 3           # post-tab-click pre-wait_for_data_loaded delay

DEFAULT_ENV_FILE = Path(r"C:\ai_projects\logserv_comp\.env")


def build_url(splunk_url: str, react_path: str) -> str:
    return f"{splunk_url}{APP_HOME}#{react_path}?{TIME_QS}"


def load_env_file(env_path: Path) -> None:
    """Load KEY=VALUE pairs from a .env file into os.environ (no overwrite)."""
    if not env_path.is_file():
        return
    with env_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def wait_for_data_loaded(page: Page, timeout_s: int = DATA_LOAD_TIMEOUT_S) -> None:
    """
    Wait until the dashboard is fully populated.

    Strategy: combine two signals.

    (A) Explicit loading-indicator count. The LogServ React app uses three
        loading-state conventions discovered by inspecting the source:
          - DataTable empty-loading: visible text 'Loading…' (HORIZONTAL ELLIPSIS)
          - DataTable line-loading: visible text 'Loading...' (three dots)
          - KpiCard.loading=true:   visible text '—' (EM DASH) where a value should be
          - Generic spinner SVG:    any element matching .dotPulse or [data-loading="true"]
        We count visible occurrences of these.

    (B) DOM stability. We take a 'fingerprint' (body scrollHeight + total text
        length + numeric-digit count + SVG/canvas count) at POLL_INTERVAL_S
        cadence; once the fingerprint hasn't changed for STABLE_FOR_S seconds
        AND (A) reports zero indicators, we are done.

    Hard ceiling of timeout_s seconds either way.
    """
    js = """
    () => {
        let loadingCount = 0;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let textLen = 0;
        let digitCount = 0;
        let n;
        while ((n = walker.nextNode())) {
            const raw = n.nodeValue || '';
            const trimmed = raw.trim();
            textLen += raw.length;
            for (let i = 0; i < raw.length; i++) {
                const c = raw.charCodeAt(i);
                if (c >= 48 && c <= 57) digitCount++;
            }
            if (trimmed === 'Loading…' || trimmed === 'Loading...' || trimmed === '—') {
                const el = n.parentElement;
                if (el) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) loadingCount += 1;
                }
            }
        }
        const spinners = document.querySelectorAll('.dotPulse, [data-loading="true"]');
        spinners.forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) loadingCount += 1;
        });
        const scrollH = document.body ? document.body.scrollHeight : 0;
        const svgs = document.querySelectorAll('svg').length;
        const canvases = document.querySelectorAll('canvas').length;
        return { loadingCount, scrollH, textLen, digitCount, svgs, canvases };
    }
    """
    deadline = time.time() + timeout_s
    last_fp = None
    last_change_at = time.time()
    last_loading_count = -1
    while time.time() < deadline:
        try:
            state = page.evaluate(js)
        except Exception:
            time.sleep(POLL_INTERVAL_S)
            continue
        loading_count = state.get("loadingCount", 0)
        fp = (state.get("scrollH"), state.get("textLen"), state.get("digitCount"),
              state.get("svgs"), state.get("canvases"))
        now = time.time()
        if fp != last_fp:
            last_fp = fp
            last_change_at = now
        stable_s = now - last_change_at
        if loading_count != last_loading_count:
            print(f"    loading={loading_count}, fp={fp}, stable_for={stable_s:.1f}s")
            last_loading_count = loading_count
        if loading_count == 0 and stable_s >= STABLE_FOR_S:
            print(f"    settled: 0 loading indicators, DOM stable for {stable_s:.1f}s")
            return
        time.sleep(POLL_INTERVAL_S)
    print(f"    timed out after {timeout_s}s (loading={last_loading_count}, fp={last_fp})")


def login(page: Page, splunk_url: str, user: str, password: str) -> None:
    page.goto(f"{splunk_url}/en-US/account/login", timeout=NAV_TIMEOUT_MS)
    page.fill("input[name=username]", user)
    page.fill("input[name=password]", password)
    page.click("input[type=submit]")
    page.wait_for_url("**/app/**", timeout=NAV_TIMEOUT_MS)


def click_tab(page: Page, tab_label: str) -> None:
    """Click a Splunk React-UI tab by visible label."""
    locator = page.get_by_role("tab", name=tab_label)
    locator.first.click(timeout=15_000)


def capture_one(page: Page, splunk_url: str, filename: str, react_path: str,
                tab_label: Optional[str], output_dir: Path) -> None:
    url = build_url(splunk_url, react_path)
    print(f"  navigating: {url}")
    page.goto(url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
    try:
        page.wait_for_load_state("networkidle", timeout=NETWORK_IDLE_MS)
    except PlaywrightTimeout:
        print("    (networkidle timed out — proceeding with what's rendered)")

    if tab_label:
        print(f"  clicking tab: {tab_label}")
        click_tab(page, tab_label)
        try:
            page.wait_for_load_state("networkidle", timeout=NETWORK_IDLE_MS)
        except PlaywrightTimeout:
            print("    (post-tab networkidle timed out)")
        wait_for_data_loaded(page)
        time.sleep(TAB_SETTLE_S)
    else:
        wait_for_data_loaded(page)
        time.sleep(EXTRA_SETTLE_S)

    out_path = output_dir / filename
    page.screenshot(path=str(out_path), full_page=True)
    size_kb = out_path.stat().st_size // 1024
    print(f"  saved: {out_path}  ({size_kb} KB)")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--splunk-url", default=os.environ.get("SPLUNK_URL", "http://3.136.169.21:8000"))
    parser.add_argument("--user", default=os.environ.get("SPLUNK_USER", "admin"))
    parser.add_argument("--only", help="Capture just one PNG by filename (e.g. dashboard-hana-audit.png)")
    parser.add_argument("--output-dir", default=str(OUTPUT_DIR))
    parser.add_argument("--env-file", default=os.environ.get("ENV_FILE", str(DEFAULT_ENV_FILE)))
    args = parser.parse_args()

    env_path = Path(args.env_file)
    load_env_file(env_path)

    password = os.environ.get("SPLUNK_ADMIN_PASS")
    if not password:
        print(
            f"ERROR: SPLUNK_ADMIN_PASS not set.\n"
            f"  Looked for it in env and in {env_path} (file exists: {env_path.is_file()}).\n"
            f"  Put 'SPLUNK_ADMIN_PASS=<pwd>' in that file, OR set the env var directly.",
            file=sys.stderr,
        )
        return 2

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    targets = DASHBOARDS
    if args.only:
        targets = [t for t in DASHBOARDS if t[0] == args.only]
        if not targets:
            print(f"ERROR: no dashboard matches --only={args.only}", file=sys.stderr)
            print("Valid filenames:")
            for f, _, _ in DASHBOARDS:
                print(f"  {f}")
            return 2

    headless = os.environ.get("HEADLESS", "1") != "0"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        ctx = browser.new_context(viewport=VIEWPORT, ignore_https_errors=True)
        page = ctx.new_page()
        page.set_default_timeout(NAV_TIMEOUT_MS)

        print(f"Logging into {args.splunk_url} as {args.user}")
        login(page, args.splunk_url, args.user, password)

        print(f"Capturing {len(targets)} dashboard(s) to {output_dir}")
        for filename, react_path, tab_label in targets:
            print(f"\n[{filename}]")
            try:
                capture_one(page, args.splunk_url, filename, react_path, tab_label, output_dir)
            except Exception as exc:   # noqa: BLE001
                print(f"  FAILED: {exc!r}")

        browser.close()

    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
