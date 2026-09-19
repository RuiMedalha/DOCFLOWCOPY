"""
Debug rehydrate timing.
"""

import json
import time

from playwright.sync_api import sync_playwright


API_BASE = "http://localhost:4000/api/v1"
WEB_BASE = "http://localhost:3000"


def login(page) -> None:
    res = page.request.post(
        f"{API_BASE}/auth/login",
        data=json.dumps(
            {"email": "admin@demo.pt", "password": "Admin123!", "tenantSlug": "demo"}
        ),
        headers={"Content-Type": "application/json"},
    )
    body = res.json()
    access = body["data"]["tokens"]["accessToken"]
    refresh = body["data"]["tokens"]["refreshToken"]
    user = body["data"]["user"]
    page.evaluate(
        """({access, refresh, user}) => {
            const payload = JSON.stringify({state: {accessToken: access, refreshToken: refresh, user}, version: 0});
            localStorage.setItem('docflow-auth', payload);
            // ALSO mirror cookie so middleware sees it.
            document.cookie = 'docflow-auth=' + encodeURIComponent(access) + '; Path=/; Max-Age=2592000; SameSite=Lax';
        }""",
        {"access": access, "refresh": refresh, "user": user},
    )


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 1024})
    page = ctx.new_page()

    page.goto(f"{WEB_BASE}/login", wait_until="networkidle")
    login(page)
    print("[debug] login ok")

    # Reload so the store picks up the persisted state.
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(500)

    raw = page.evaluate("() => localStorage.getItem('docflow-auth')")
    print(f"[debug] localStorage docflow-auth: {raw[:80] if raw else None!r}")

    token = page.evaluate("() => JSON.parse(localStorage.getItem('docflow-auth')).state.accessToken")
    print(f"[debug] token in localStorage: {bool(token)}, len={len(token) if token else 0}")

    # Check cookie
    cookies = ctx.cookies()
    auth_cookie = next((c for c in cookies if c["name"] == "docflow-auth"), None)
    print(f"[debug] cookie docflow-auth present: {bool(auth_cookie)}, len={len(auth_cookie['value']) if auth_cookie else 0}")

    items_resp = page.request.get(f"{API_BASE}/documents?limit=10", headers={"Authorization": f"Bearer {token}"})
    items = items_resp.json()["data"]["items"]
    target = next((d for d in items if d.get("status") == "APROVADO" and d.get("docNumber")), items[0])
    doc_id = target["id"]
    print(f"[debug] target doc id={doc_id}")

    page.goto(f"{WEB_BASE}/documents/{doc_id}", wait_until="networkidle")
    page.wait_for_timeout(2500)

    print(f"[debug] final URL: {page.url}")
    print(f"[debug] h1 count: {page.locator('h1').count()}")

    if page.locator("h1").count() > 0:
        first_h1 = page.locator("h1").first
        box = first_h1.bounding_box()
        print(f"[debug] h1 box: {box}")
        font_size = first_h1.evaluate("el => getComputedStyle(el).fontSize")
        font_family = first_h1.evaluate("el => getComputedStyle(el).fontFamily")
        print(f"[debug] h1 font: {font_family!r} {font_size}")

    # Find body data-skin
    skin = page.evaluate("() => Array.from(document.querySelectorAll('[data-skin]')).map(e => e.dataset.skin)")
    print(f"[debug] data-skin elements: {skin}")

    found = page.evaluate("""() => {
        const all = Array.from(document.querySelectorAll('h1,h2,h3,p,span,div,button'));
        return all.map(el => {
            const fam = getComputedStyle(el).fontFamily || '';
            if (/Fraunces|font-editorial|ui-serif, Georgia/i.test(fam)) {
                return {
                    tag: el.tagName,
                    text: (el.textContent || '').slice(0, 60),
                    font: fam,
                };
            }
            return null;
        }).filter(Boolean).slice(0, 10);
    }""")
    print(f"[debug] fraunces elements: {len(found)}")
    for el in found:
        print(f"   {el}")

    page.screenshot(path="audit-and-ui-overhaul/UI-OVERHAUL-BEFORE-AFTER.png", full_page=True)
    print("[debug] screenshot saved")

    browser.close()
