"""Key-free Korean region search with optional, explicit Kakao or Nominatim opt-in.

The built-in rectangles are approximate map viewports, not administrative
boundaries or surveyed data. No upstream lookup happens while typing.
"""

import copy
import math
import os
import re
import threading
import time
from collections import OrderedDict

import httpx

LOCAL_ATTRIBUTION = "내장 지역 중심점·근사 화면 범위 (행정경계 자료 아님)"
OSM_ATTRIBUTION = "© OpenStreetMap contributors · ODbL · https://www.openstreetmap.org/copyright"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
KAKAO_ATTRIBUTION = "장소·주소 검색 © Kakao"
KAKAO_KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"
KAKAO_ADDRESS_URL = "https://dapi.kakao.com/v2/local/search/address.json"
USER_AGENT = "Solar-Site-Workspace/1.0 (Korean solar feasibility desktop workspace)"
CACHE_TTL = 24 * 60 * 60
_cache = OrderedDict()
_upstream_lock = threading.Lock()
_last_request_at = None

# lat/lon are representative city centres; boxes only control map zoom.
# Province rows: official label, aliases, latitude, longitude, W/S/E/N viewport.
_PROVINCES = [
    ("서울특별시", "서울|서울시|seoul", 37.5665, 126.9780, (126.76, 37.42, 127.19, 37.71)),
    ("부산광역시", "부산|부산시|busan", 35.1796, 129.0756, (128.80, 34.98, 129.32, 35.40)),
    ("대구광역시", "대구|대구시|daegu", 35.8714, 128.6014, (128.35, 35.58, 128.89, 36.33)),
    ("인천광역시", "인천|인천시|incheon", 37.4563, 126.7052, (126.12, 37.20, 126.81, 37.87)),
    ("광주광역시", "광주|gwangju", 35.1595, 126.8526, (126.64, 35.05, 127.02, 35.27)),
    ("대전광역시", "대전|대전시|daejeon", 36.3504, 127.3845, (127.24, 36.18, 127.57, 36.50)),
    ("울산광역시", "울산|울산시|ulsan", 35.5395, 129.3114, (128.98, 35.32, 129.49, 35.73)),
    ("세종특별자치시", "세종|세종시|sejong", 36.4800, 127.2890, (127.14, 36.41, 127.41, 36.74)),
    ("경기도", "경기|gyeonggi", 37.4000, 127.1500, (126.36, 36.89, 127.86, 38.30)),
    ("강원특별자치도", "강원|강원도|gangwon", 37.8000, 128.2000, (126.97, 37.02, 129.38, 38.62)),
    ("충청북도", "충북|chungbuk", 36.8000, 127.7000, (127.27, 36.01, 128.65, 37.26)),
    ("충청남도", "충남|chungnam", 36.6000, 126.8000, (126.12, 35.97, 127.64, 37.07)),
    ("전북특별자치도", "전북|전라북도|jeonbuk", 35.7500, 127.1500, (126.09, 35.30, 127.90, 36.15)),
    ("전라남도", "전남|jeonnam", 34.8500, 126.9500, (125.08, 33.98, 127.90, 35.48)),
    ("경상북도", "경북|gyeongbuk", 36.2500, 128.8000, (127.80, 35.56, 129.60, 37.14)),
    ("경상남도", "경남|gyeongnam", 35.3500, 128.2500, (127.56, 34.57, 129.23, 35.91)),
    ("제주특별자치도", "제주|제주도|jeju", 33.3800, 126.5500, (126.12, 33.10, 126.99, 33.62)),
]

# Each entry: 시/군 name, centre latitude, centre longitude. County viewports
# are wider than compact urban ones. This is a small offline gazetteer.
_CITIES = {
    "경기도": "수원시,37.2636,127.0286;성남시,37.4200,127.1267;의정부시,37.7381,127.0337;안양시,37.3943,126.9568;부천시,37.5034,126.7660;광명시,37.4785,126.8647;평택시,36.9921,127.1129;동두천시,37.9036,127.0606;안산시,37.3219,126.8309;고양시,37.6584,126.8320;과천시,37.4292,126.9876;구리시,37.5943,127.1296;남양주시,37.6360,127.2165;오산시,37.1498,127.0772;시흥시,37.3802,126.8029;군포시,37.3617,126.9352;의왕시,37.3447,126.9683;하남시,37.5393,127.2149;용인시,37.2411,127.1776;파주시,37.7599,126.7802;이천시,37.2721,127.4350;안성시,37.0080,127.2798;김포시,37.6152,126.7156;화성시,37.1995,126.8312;광주시,37.4294,127.2551;양주시,37.7853,127.0458;포천시,37.8949,127.2002;여주시,37.2982,127.6370;연천군,38.0964,127.0748;가평군,37.8315,127.5095;양평군,37.4917,127.4876",
    "강원특별자치도": "춘천시,37.8813,127.7298;원주시,37.3422,127.9202;강릉시,37.7519,128.8761;동해시,37.5247,129.1143;태백시,37.1640,128.9856;속초시,38.2070,128.5918;삼척시,37.4499,129.1650;홍천군,37.6972,127.8887;횡성군,37.4919,127.9840;영월군,37.1836,128.4618;평창군,37.3705,128.3903;정선군,37.3806,128.6608;철원군,38.1466,127.3135;화천군,38.1061,127.7082;양구군,38.1100,127.9890;인제군,38.0695,128.1707;고성군,38.3806,128.4678;양양군,38.0754,128.6190",
    "충청북도": "청주시,36.6424,127.4890;충주시,36.9910,127.9259;제천시,37.1326,128.1909;보은군,36.4895,127.7294;옥천군,36.3064,127.5713;영동군,36.1750,127.7834;증평군,36.7853,127.5816;진천군,36.8554,127.4358;괴산군,36.8153,127.7867;음성군,36.9403,127.6905;단양군,36.9846,128.3655",
    "충청남도": "천안시,36.8151,127.1139;공주시,36.4465,127.1190;보령시,36.3335,126.6120;아산시,36.7898,127.0019;서산시,36.7849,126.4503;논산시,36.1872,127.0987;계룡시,36.2744,127.2490;당진시,36.8899,126.6460;금산군,36.1087,127.4881;부여군,36.2756,126.9098;서천군,36.0803,126.6917;청양군,36.4592,126.8022;홍성군,36.6012,126.6608;예산군,36.6809,126.8448;태안군,36.7456,126.2980",
    "전북특별자치도": "전주시,35.8242,127.1480;군산시,35.9677,126.7369;익산시,35.9483,126.9578;정읍시,35.5699,126.8558;남원시,35.4164,127.3903;김제시,35.8036,126.8809;완주군,35.9049,127.1620;진안군,35.7917,127.4248;무주군,36.0068,127.6608;장수군,35.6473,127.5210;임실군,35.6179,127.2890;순창군,35.3745,127.1375;고창군,35.4358,126.7020;부안군,35.7316,126.7335",
    "전라남도": "목포시,34.8118,126.3922;여수시,34.7604,127.6622;순천시,34.9506,127.4873;나주시,35.0159,126.7108;광양시,34.9407,127.6959;담양군,35.3212,126.9882;곡성군,35.2820,127.2922;구례군,35.2026,127.4628;고흥군,34.6112,127.2840;보성군,34.7715,127.0799;화순군,35.0645,126.9866;장흥군,34.6816,126.9071;강진군,34.6421,126.7672;해남군,34.5733,126.5993;영암군,34.8002,126.6968;무안군,34.9905,126.4817;함평군,35.0659,126.5166;영광군,35.2772,126.5121;장성군,35.3018,126.7849;완도군,34.3104,126.7550;진도군,34.4869,126.2635;신안군,34.8337,126.3512",
    "경상북도": "포항시,36.0190,129.3435;경주시,35.8562,129.2247;김천시,36.1398,128.1136;안동시,36.5684,128.7294;구미시,36.1195,128.3446;영주시,36.8057,128.6240;영천시,35.9733,128.9386;상주시,36.4109,128.1591;문경시,36.5865,128.1868;경산시,35.8251,128.7415;의성군,36.3527,128.6970;청송군,36.4360,129.0572;영양군,36.6667,129.1124;영덕군,36.4150,129.3650;청도군,35.6473,128.7330;고령군,35.7261,128.2630;성주군,35.9190,128.2829;칠곡군,35.9955,128.4017;예천군,36.6469,128.4374;봉화군,36.8931,128.7324;울진군,36.9931,129.4004;울릉군,37.4845,130.9057",
    "경상남도": "창원시,35.2281,128.6811;진주시,35.1799,128.1076;통영시,34.8544,128.4331;사천시,35.0038,128.0641;김해시,35.2285,128.8894;밀양시,35.5037,128.7464;거제시,34.8806,128.6211;양산시,35.3350,129.0373;의령군,35.3222,128.2617;함안군,35.2723,128.4066;창녕군,35.5446,128.4923;고성군,34.9731,128.3224;남해군,34.8377,127.8925;하동군,35.0672,127.7513;산청군,35.4156,127.8735;함양군,35.5205,127.7252;거창군,35.6874,127.9095;합천군,35.5667,128.1659",
    "제주특별자치도": "제주시,33.4996,126.5312;서귀포시,33.2541,126.5601",
    "대구광역시": "군위군,36.2428,128.5728",
}


def _normalize(query):
    value = re.sub(r"\s+", "", query.casefold())
    for prefix in ("대한민국", "한국"):
        if value.startswith(prefix):
            value = value[len(prefix):]
    return value


def _build_regions():
    regions, province_aliases = [], {}
    for label, aliases, latitude, longitude, bbox in _PROVINCES:
        names = [label, *aliases.split("|")]
        province_aliases[label] = names
        regions.append(({"id": f"local-{label}", "label": label, "latitude": latitude,
                         "longitude": longitude, "bbox": list(bbox), "source": "local", "kind": "region"},
                        {_normalize(name) for name in names}))
    for province, rows in _CITIES.items():
        for row in rows.split(";"):
            name, latitude, longitude = row.split(",")
            latitude, longitude = float(latitude), float(longitude)
            short_name = name[:-1] if name.endswith(("시", "군")) else name
            aliases = {name, short_name}
            for prefix in province_aliases[province]:
                aliases.update((prefix + name, prefix + short_name))
            latitude_radius, longitude_radius = (.19, .25) if name.endswith("군") else (.09, .12)
            bbox = [round(longitude-longitude_radius, 5), round(latitude-latitude_radius, 5),
                    round(longitude+longitude_radius, 5), round(latitude+latitude_radius, 5)]
            regions.append(({"id": f"local-{province}-{name}", "label": f"{province} {name}",
                             "latitude": latitude, "longitude": longitude, "bbox": bbox,
                             "source": "local", "kind": "region"}, {_normalize(alias) for alias in aliases}))
    return regions


REGIONS = _build_regions()


def _response(results, provider="local", warning=None):
    attribution = {"nominatim": OSM_ATTRIBUTION, "kakao": KAKAO_ATTRIBUTION}.get(provider, LOCAL_ATTRIBUTION)
    return {"results": results, "provider": provider, "warning": warning, "attribution": attribution}


def _coordinates(query):
    match = re.fullmatch(r"\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*", query)
    if not match:
        return None
    latitude, longitude = (float(value) for value in match.groups())
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise ValueError("위도는 -90~90, 경도는 -180~180 범위로 입력하세요.")
    return {"id": f"local-coordinates-{latitude}-{longitude}", "label": f"위도 {latitude:g}, 경도 {longitude:g}",
            "latitude": latitude, "longitude": longitude,
            "bbox": [max(-180, longitude-.01), max(-90, latitude-.01),
                     min(180, longitude+.01), min(90, latitude+.01)], "source": "local", "kind": "place"}


def _request_upstream(query):
    # This fixed endpoint cannot be changed by a search query. Administrators can
    # immediately disable the provider by setting GEOCODING_PROVIDER=local.
    with httpx.Client(timeout=5.0, follow_redirects=False, headers={"User-Agent": USER_AGENT}) as client:
        response = client.get(NOMINATIM_URL, params={"q": query, "format": "jsonv2", "countrycodes": "kr",
                                                    "accept-language": "ko", "limit": 5})
        response.raise_for_status()
        return response.json()


def _request_kakao(query):
    """Keyword search finds apartments, buildings and POIs; address search is the fallback."""
    headers = {"Authorization": f"KakaoAK {os.environ['KAKAO_REST_API_KEY'].strip()}"}
    with httpx.Client(timeout=5.0, follow_redirects=False, headers=headers) as client:
        keyword = client.get(KAKAO_KEYWORD_URL, params={"query": query, "size": 5})
        keyword.raise_for_status()
        payload = keyword.json()
        if payload.get("documents"):
            return payload
        address = client.get(KAKAO_ADDRESS_URL, params={"query": query, "size": 5})
        address.raise_for_status()
        return address.json()


def _parse_kakao(payload):
    rows = payload.get("documents") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError("Invalid geocoder response")
    results = []
    for row in rows[:5]:
        try:
            longitude, latitude = float(row["x"]), float(row["y"])
            if not (33 <= latitude <= 39 and 124 <= longitude <= 132):
                continue
            place = str(row.get("place_name") or "").strip()
            address = str(row.get("road_address_name") or row.get("address_name") or "").strip()
            label = " · ".join(v for v in (place, address) if v)[:400]
            if not label:
                continue
            results.append({"id": f"kakao-{row.get('id') or len(results)}-{latitude}-{longitude}", "label": label,
                            "latitude": latitude, "longitude": longitude,
                            "bbox": [longitude-.004, latitude-.003, longitude+.004, latitude+.003],
                            "source": "kakao", "kind": "place"})
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    return results


def _parse_upstream(rows):
    if not isinstance(rows, list):
        raise ValueError("Invalid geocoder response")
    results = []
    for row in rows[:5]:
        try:
            latitude, longitude = float(row["lat"]), float(row["lon"])
            if not (math.isfinite(latitude) and math.isfinite(longitude)
                    and -90 <= latitude <= 90 and -180 <= longitude <= 180):
                continue
            south, north, west, east = map(float, row.get("boundingbox", [latitude-.005, latitude+.005,
                                                                         longitude-.005, longitude+.005]))
            if not (-90 <= south <= latitude <= north <= 90 and -180 <= west <= longitude <= east <= 180):
                continue
            label = str(row["display_name"]).strip()[:400]
            if not label:
                continue
            identifier = str(row.get("osm_type", "place")) + "-" + str(row.get("osm_id", row.get("place_id", len(results))))
            kind = "region" if row.get("category") == "boundary" or row.get("addresstype") in {"state", "city", "county", "province"} else "place"
            results.append({"id": f"nominatim-{identifier}", "label": label, "latitude": latitude,
                            "longitude": longitude, "bbox": [west, south, east, north], "source": "nominatim", "kind": kind})
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    return results


def search_places(query):
    """Search on explicit submit; known region names always stay on-device."""
    global _last_request_at
    query = " ".join(query.split())
    if not 2 <= len(query) <= 120:
        raise ValueError("검색어를 2~120자로 입력하세요.")
    point = _coordinates(query)
    if point:
        return _response([point])
    normalized = _normalize(query)
    if normalized in {"", "전국", "korea", "southkorea"}:
        return _response([{"id": "local-korea", "label": "대한민국", "latitude": 36.3, "longitude": 127.8,
                           "bbox": [124.5, 33.0, 131.2, 38.7], "source": "local", "kind": "region"}])
    exact = [copy.deepcopy(region) for region, aliases in REGIONS if normalized in aliases]
    if exact:
        return _response(exact[:5])
    suggestions = [copy.deepcopy(region) for region, aliases in REGIONS
                   if any(normalized in alias or alias in normalized for alias in aliases if len(alias) >= 2)][:5]
    provider = os.getenv("GEOCODING_PROVIDER", "local").lower()
    if provider == "kakao" and not os.getenv("KAKAO_REST_API_KEY", "").strip():
        return _response(suggestions, warning="카카오 검색이 켜져 있지만 KAKAO_REST_API_KEY가 없습니다. 서버 .env에 키를 넣고 다시 시작하세요.")
    if provider not in ("nominatim", "kakao"):
        return _response(suggestions, warning="지금은 시·군 이름과 '위도, 경도'만 찾을 수 있습니다. 아파트·건물·주소 검색은 서버에 카카오 API 키를 설정하면 사용할 수 있습니다.")

    cache_key = provider + ":" + query.casefold()
    # Serialise all upstream requests across FastAPI worker threads. Hold the
    # lock through IO so simultaneous duplicate queries only request once.
    with _upstream_lock:
        current = time.monotonic()
        cached = _cache.get(cache_key)
        if cached and cached[0] > current:
            _cache.move_to_end(cache_key)
            return copy.deepcopy(cached[1])
        if _last_request_at is not None and provider == "nominatim":
            delay = 1.0 - (current - _last_request_at)
            if delay > 0:
                time.sleep(delay)
        _last_request_at = time.monotonic()
        try:
            matches = (_parse_kakao(_request_kakao(query)) if provider == "kakao"
                       else _parse_upstream(_request_upstream(query)))
            result = _response(matches, provider, None if matches else "검색 결과가 없습니다. 시·군 이름이나 다른 주소로 검색하세요.")
            ttl = CACHE_TTL
        except (httpx.HTTPError, ValueError, TypeError):
            result = _response(suggestions, warning="외부 주소 검색에 연결할 수 없습니다. 내장 지역 결과를 표시합니다. 잠시 후 다시 검색하거나 시·군 이름으로 검색하세요.")
            ttl = 60  # Short negative cache prevents repeated upstream failures.
        _cache[cache_key] = (time.monotonic() + ttl, result)
        _cache.move_to_end(cache_key)
        while len(_cache) > 512:
            _cache.popitem(last=False)
        return copy.deepcopy(result)
