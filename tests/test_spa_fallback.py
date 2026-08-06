"""
SPA deep links.

The frontend is a client-side router: /upload, /queue and /case/3 exist only in
the browser. A direct load or refresh of any of them reaches the server, which
must answer with index.html and let React resolve the path.

StaticFiles(html=True) alone does not do this -- it serves index.html for
directory paths only, so every non-root page 404s. These tests pin the explicit
fallback down, and guard the two things it must not swallow: real API routes,
and missing asset files.
"""

import pytest


@pytest.fixture
def api_with_frontend(tmp_path, monkeypatch):
    """A TestClient with a stand-in frontend build mounted."""
    import sys

    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(
        "<!doctype html><title>SmileAI</title><div id=root></div>", encoding="utf-8"
    )
    assets = dist / "assets"
    assets.mkdir()
    (assets / "index-abc123.js").write_text("console.log('app')", encoding="utf-8")

    db_path = tmp_path / "spa.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_path}")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SMILEAI_FRONTEND_DIST", str(dist))

    for module in ("main", "db"):
        sys.modules.pop(module, None)

    from fastapi.testclient import TestClient
    import db as db_module
    import main as main_module

    db_module.init_db()
    with TestClient(main_module.app) as client:
        yield client


class TestSpaDeepLinks:
    def test_root_serves_the_app(self, api_with_frontend):
        resp = api_with_frontend.get("/")
        assert resp.status_code == 200
        assert "SmileAI" in resp.text

    @pytest.mark.parametrize("path", [
        "/upload", "/queue", "/patients", "/referrals", "/settings",
        "/case/3", "/patients/MRN-9001",
    ])
    def test_client_routes_serve_index_html(self, api_with_frontend, path):
        """Refreshing any page must load the app, not a 404."""
        resp = api_with_frontend.get(path)
        assert resp.status_code == 200, f"{path} must fall back to index.html"
        assert "<div id=root>" in resp.text

    def test_real_assets_are_still_served(self, api_with_frontend):
        resp = api_with_frontend.get("/assets/index-abc123.js")
        assert resp.status_code == 200
        assert "console.log" in resp.text

    def test_missing_asset_is_404_not_the_app(self, api_with_frontend):
        """A bad bundle path must fail loudly, not return HTML to a <script> tag."""
        resp = api_with_frontend.get("/assets/does-not-exist.js")
        assert resp.status_code == 404

    def test_unknown_api_route_is_404_not_the_app(self, api_with_frontend):
        """The fallback must never mask an API typo by returning HTML."""
        resp = api_with_frontend.get("/api/nope")
        assert resp.status_code == 404
        assert "<div id=root>" not in resp.text

    def test_real_api_routes_still_work(self, api_with_frontend):
        assert api_with_frontend.get("/api/stats").status_code == 200
        assert api_with_frontend.get("/api/queue").status_code == 200
