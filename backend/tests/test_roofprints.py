from shapely.geometry import Polygon, box, mapping

from app import roofprints


def test_overlapping_tiles_return_full_building_and_courtyard_is_not_a_roof(monkeypatch, tmp_path):
    monkeypatch.setenv("WATER_CACHE_DIR", str(tmp_path))
    outside = box(127.052, 37.282, 127.056, 37.286)
    courtyard = box(127.053, 37.283, 127.054, 37.284)
    geometry = Polygon(outside.exterior.coords, [courtyard.exterior.coords])
    raw = {"id": "verified-test-building", "geometry": geometry.wkb, "is_underground": False,
           "names": {"primary": "Rooftop", "common": [("ko", "옥상 건물")]}, "sources": [],
           "class": None, "subtype": "office", "num_floors": 3, "height": 12, "roof_shape": "flat"}
    calls = []
    monkeypatch.setattr(roofprints, "_fetch", lambda bounds: calls.append(bounds) or [raw])
    features = roofprints.viewport(127.0521, 37.2821, 127.0525, 37.2825)
    assert features[0]["name"] == "옥상 건물"
    assert features[0]["geometry"] == mapping(geometry)
    assert roofprints.identify(37.2822, 127.0522)["id"] == "overture/verified-test-building"
    assert roofprints.identify(37.2835, 127.0535) is None
    assert len(calls) == 1
