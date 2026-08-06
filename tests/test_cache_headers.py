"""
Cache headers on the frontend.

index.html names the current bundle hashes, so a stale copy points at an asset
that no longer exists -- the browser then 404s on a hash nobody has and renders
a white page. It must never be cached.

Hashed assets are the opposite: the filename changes whenever the content does,
so they are safe to cache indefinitely and doing so avoids re-downloading ~700 KB
of JS on every visit.
"""

import pytest


@pytest.fixture
def api_with_frontend(tmp_path, monkeypatch):
    import sys

    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(
        "<!doctype html><script src=/assets/index-abc123.js></script>", encoding="utf-8"
    )
    (dist / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    assets = dist / "assets"
    assets.mkdir()
    (assets / "index-abc123.js").write_text("console.log('app')", encoding="utf-8")

    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'cache.db'}")
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


def _no_store(headers):
    cc = headers.get("cache-control", "").lower()
    return "no-store" in cc or "no-cache" in cc


class TestIndexHtmlIsNeverCached:
    def test_root_sends_no_store(self, api_with_frontend):
        resp = api_with_frontend.get("/")
        assert resp.status_code == 200
        assert _no_store(resp.headers), (
            "index.html must not be cacheable: a stale copy references a bundle "
            f"hash that no longer exists. Got {resp.headers.get('cache-control')!r}"
        )

    @pytest.mark.parametrize("path", ["/upload", "/queue", "/patients", "/case/3"])
    def test_spa_fallback_sends_no_store(self, api_with_frontend, path):
        """The deep-link fallback returns index.html too, so the same rule applies."""
        resp = api_with_frontend.get(path)
        assert resp.status_code == 200
        assert _no_store(resp.headers), f"{path} served a cacheable index.html"


class TestHashedAssetsAreCachedHard:
    def test_hashed_asset_is_immutable(self, api_with_frontend):
        resp = api_with_frontend.get("/assets/index-abc123.js")
        assert resp.status_code == 200
        cc = resp.headers.get("cache-control", "").lower()
        assert "immutable" in cc or "max-age=31536000" in cc, (
            f"hashed assets should cache for a year, got {cc!r}"
        )

    def test_hashed_asset_is_not_no_store(self, api_with_frontend):
        """Re-downloading 700 KB of JS on every page view is the failure here."""
        resp = api_with_frontend.get("/assets/index-abc123.js")
        assert not _no_store(resp.headers)


class TestApiIsUnaffected:
    def test_api_responses_are_not_given_asset_caching(self, api_with_frontend):
        resp = api_with_frontend.get("/api/stats")
        assert resp.status_code == 200
        cc = resp.headers.get("cache-control", "").lower()
        assert "immutable" not in cc, "API data must never be cached as immutable"
