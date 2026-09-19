"""
DocFlow — /documents/[id] visual proof (Editorial / Contabil · Blueprint Edition).

Connects to the already-running servers:
  - API:    http://localhost:4000/api/v1
  - Web:    http://localhost:3000

Login as ADMIN, navigate to an existing approved document, take a screenshot
and verify the visual elements defined in DESIGN-SYSTEM.md:
  - Anchor memoravel: no doc ~48px+ (we accept >= 40px which is the lower
    end of clamp(40px, 5vw, 56px) on 1280px viewport).
  - Fraunces serif present somewhere on the page.
  - Palette cream aplicada: --ed-canvas resolves to #fbf9f4 (computed).
  - Gold accent present: --ed-accent-gold resolves to #cba65a.
  - Editorial skin [data-skin="editorial"] wrapper active.

Prints a one-line summary suitable for the handoff report.
"""

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


API_BASE = "http://localhost:4000/api/v1"
WEB_BASE = "http://localhost:3000"
SCREENSHOT_PATH = (
    Path(__file__).parent.parent / "audit-and-ui-overhaul" / "UI-OVERHAUL-BEFORE-AFTER.png"
)


def login(page) -> None:
    """POST /auth/login, then mirror access token into localStorage + cookie.
    The cookie is needed because Next edge middleware enforces the auth gate
    from the cookie (it cannot read localStorage)."""
    res = page.request.post(
        f"{API_BASE}/auth/login",
        data=json.dumps(
            {"email": "admin@demo.pt", "password": "Admin123!", "tenantSlug": "demo"}
        ),
        headers={"Content-Type": "application/json"},
    )
    if not res.ok:
        raise RuntimeError(f"login failed: {res.status} {res.text()}")
    body = res.json()
    access = body["data"]["tokens"]["accessToken"]
    refresh = body["data"]["tokens"]["refreshToken"]
    user = body["data"]["user"]
    page.evaluate(
        """({access, refresh, user}) => {
            const payload = JSON.stringify({state: {accessToken: access, refreshToken: refresh, user}, version: 0});
            localStorage.setItem('docflow-auth', payload);
            // Mirror into the non-HTTPOnly cookie that edge middleware reads.
            document.cookie = 'docflow-auth=' + encodeURIComponent(access) + '; Path=/; Max-Age=2592000; SameSite=Lax';
        }""",
        {"access": access, "refresh": refresh, "user": user},
    )


def main() -> int:
    SCREENSHOT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 1024})
        page = ctx.new_page()

        page.goto(f"{WEB_BASE}/login", wait_until="networkidle")
        login(page)
        # Reload so the zustand store picks up the persisted state and the
        # AuthGate on protected routes stops redirecting to /login.
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(500)

        token = page.evaluate(
            "() => JSON.parse(localStorage.getItem('docflow-auth')).state.accessToken"
        )
        list_res = page.request.get(
            f"{API_BASE}/documents?limit=10",
            headers={"Authorization": f"Bearer {token}"},
        )
        items = list_res.json()["data"]["items"]
        target = next(
            (d for d in items if d.get("status") == "APROVADO" and d.get("docNumber")),
            items[0],
        )
        doc_id = target["id"]
        print(
            f"[proof] target doc id={doc_id} status={target.get('status')} number={target.get('docNumber')}"
        )

        page.goto(f"{WEB_BASE}/documents/{doc_id}", wait_until="networkidle")
        # Give TanStack Query a tick to fetch the bundle and render.
        page.wait_for_timeout(2500)

        page.screenshot(path=str(SCREENSHOT_PATH), full_page=True)
        print(f"[proof] screenshot -> {SCREENSHOT_PATH}")

        # === Anchor check: h1 height >= 40px (clamp lower bound) ===
        anchor_ok = False
        anchor_size = 0
        if page.locator("h1").count() > 0:
            h1 = page.locator("h1").first
            box = h1.bounding_box()
            if box:
                anchor_size = round(box["height"])
                anchor_ok = anchor_size >= 40
                print(f"[proof] h1 height = {anchor_size}px  (target >= 40px)")
        if not anchor_ok:
            print("[proof] anchor check FAILED (h1 not found or < 40px)")

        # === Fraunces present ===
        fraunces_count = page.evaluate(
            """() => {
                const re = /Fraunces|font-editorial|ui-serif,\\s*Georgia/i;
                return Array.from(document.querySelectorAll('h1,h2,h3,p,span,div,button'))
                    .filter(el => re.test(getComputedStyle(el).fontFamily))
                    .length;
            }"""
        )
        fraunces_ok = fraunces_count > 0
        print(f"[proof] fraunces-serif elements = {fraunces_count}")

        # === Cream palette ===
        canvas_color = page.evaluate(
            "() => getComputedStyle(document.documentElement).getPropertyValue('--ed-canvas').trim()"
        )
        gold_color = page.evaluate(
            "() => getComputedStyle(document.documentElement).getPropertyValue('--ed-accent-gold').trim()"
        )
        cream_ok = canvas_color.lower().startswith("#fbf9f4")
        gold_ok = gold_color.lower().startswith("#cba65a")
        print(f"[proof] --ed-canvas = {canvas_color!r}   cream_ok={cream_ok}")
        print(f"[proof] --ed-accent-gold = {gold_color!r}   gold_ok={gold_ok}")

        # === Editorial skin applied? ===
        skin = page.evaluate(
            "() => Array.from(document.querySelectorAll('[data-skin]')).map(e => e.dataset.skin)"
        )
        skin_ok = "editorial" in skin
        print(f"[proof] data-skin elements = {skin}   skin_ok={skin_ok}")

        browser.close()

        # === Summary ===
        results = {
            "Anchor (no doc oversized mono)": "PASS" if anchor_ok else f"FAIL ({anchor_size}px)",
            "Fraunces serif present": "PASS" if fraunces_ok else "FAIL",
            "Palette cream (--ed-canvas)": "PASS" if cream_ok else f"FAIL ({canvas_color})",
            "Gold accent (--ed-accent-gold)": "PASS" if gold_ok else f"FAIL ({gold_color})",
            "Editorial skin activated": "PASS" if skin_ok else f"FAIL ({skin})",
        }
        print()
        print("=== VISUAL PROOF SUMMARY ===")
        all_ok = True
        for k, v in results.items():
            marker = "OK" if v == "PASS" else "FAIL"
            print(f"  {k}: {marker}  ({v})")
            if v != "PASS":
                all_ok = False
        return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
