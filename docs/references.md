# 참고 서비스와 공식 기술 문서

확인일: 2026-10-17 (Asia/Seoul). 아래 서비스는 화면·작업 흐름의 참고다. 이 MVP는 각 서비스의 비공개 API, 계통 용량, 규제, 음영, LiDAR 자료를 수집하거나 통합하지 않는다.

## 참고한 서비스

| 원문 | 확인한 구성 | MVP에 반영한 방향 |
| --- | --- | --- |
| [경기기후플랫폼 태양광 현황](https://climate.gg.go.kr/ips/engy/solar-adoption) | 잠재량·설비현황·도입 시뮬레이션을 구분하고 데이터 작성방법을 안내한다. 설비 조건을 바꾸며 발전량·비용을 검토한다. | 지도에서 후보지를 선택하고 조건을 조정한 뒤 결과를 비교하는 작업 화면. 자료 출처와 가정을 결과에 함께 기록 |
| [신재생 계통 지도](https://re100market.com/) / [서비스 소개](https://re100market.com/intro) | 계통 검색, 지적정보, 거리·면적 측정, 분석 저장을 안내하는 지도 중심 서비스다. | 후보지·연결점·직선거리의 시각화와 분석 목록. 실제 케이블 거리는 사용자가 별도로 입력 |

경기기후플랫폼의 공개 설명은 옥상·지상 태양광과 정밀 공간자료를 다룬다. 본 MVP의 합성 수면 후보지 계산은 그 자료나 정확도를 이어받은 것이 아니다. 신재생 계통 지도의 소개 문구도 본 MVP의 계통 연계 가능성이나 실시간 정보 제공을 의미하지 않는다. 두 번째 서비스는 동적 페이지여서 이번 검토에서는 공식 검색 결과에 노출된 공개 메뉴·소개 범위까지 확인했다.

## 기술 문서

구체적인 설치 버전은 `frontend/package.json`, `frontend/package-lock.json`, `backend/requirements.txt`가 기준이다. 문서의 최신 예제를 그대로 혼합하지 않고, 저장소에 고정한 버전으로 빌드·실행을 확인한다.

- [React 학습 문서](https://react.dev/learn): 컴포넌트, 상태, 이벤트 처리.
- [Vite 시작 가이드](https://vite.dev/guide/): React·TypeScript 템플릿, 개발 서버·빌드. Node.js 20.19+ 또는 22.12+ 요구를 확인했다.
- [Leaflet 1.9.4 API](https://leafletjs.com/reference.html): 2D 지도, OpenStreetMap 타일, GeoJSON, 확대 범위·드래그 이벤트. 이번 지도 개선에서 WebGL 의존성을 없애기 위해 적용했다.
- [OpenStreetMap 타일 사용 정책](https://operations.osmfoundation.org/policies/tiles/): 출처 표시·요청·캐시 기준. 화면에 출처를 유지하며 대량 다운로드를 수행하지 않는다.
- [Recharts BarChart](https://recharts.github.io/en-US/api/BarChart/): 월별 발전량·대안 그래프.
- [FastAPI 튜토리얼](https://fastapi.tiangolo.com/tutorial/): API 경로, 요청 검증, 응답·개발 실행.
- [pvlib 0.15.2 API](https://pvlib-python.readthedocs.io/en/v0.15.2/reference/generated/pvlib.pvsystem.PVSystem.html): 고정한 계산 라이브러리 버전의 태양광 모델 API. 실제 사용 함수는 `backend/app/engine/energy.py`에 모아 두었다.
- [Firebase Admin SDK 설치](https://firebase.google.com/docs/admin/setup): 서버 전용 초기화, Application Default Credentials, 서비스 계정 환경변수.
- [Firestore Emulator 연결](https://firebase.google.com/docs/emulator-suite/connect_firestore): `FIRESTORE_EMULATOR_HOST`의 프로토콜 없는 `host:port`, 동일 프로젝트 ID 사용. `demo-` 프로젝트를 사용한다.
- [Emulator Suite 설정](https://firebase.google.com/docs/emulator-suite/install_and_configure): `firebase.json`, Firestore 8080·UI 4000, `--only`, 가져오기·종료 시 내보내기.
- [Firebase CLI 14.19.1 릴리스](https://github.com/firebase/firebase-tools/releases/tag/v14.19.1): 컨테이너 CLI 버전 고정. npm 배포 메타데이터에서 해당 버전의 Node.js 20 이상 지원도 확인했다.
- [Docker Compose 시작 순서](https://docs.docker.com/compose/how-tos/startup-order/): 서비스 준비 상태를 `healthcheck`와 `depends_on: condition: service_healthy`로 연결.

Firestore는 React에서 직접 쓰지 않고 FastAPI의 Admin SDK 어댑터로 접근한다. 제공한 Firestore 규칙은 클라이언트 접근을 거부한다. Admin SDK 서버 권한과 API 접근 통제는 별개이며, 이 MVP의 인증 없는 서버는 로컬 단일 사용자용이다.

## 지역·주소 검색

- 기본 `GEOCODING_PROVIDER=local`은 171개 시도·시군의 내장 중심점과 근사 화면 범위를 사용한다. 예: `수원`, `경기도 수원시`, `양평`, `충주`, `합천`, `전라남도`, `37.2636, 127.0286`. 범위 사각형은 지도를 확대하기 위한 값이며 실제 행정경계가 아니다. 기본 모드에서는 검색어를 외부로 보내지 않는다.
- 상세 주소 검색은 선택 기능이다. 운영자가 아래 정책을 읽고 사용 책임과 전송 범위를 확인한 뒤 서버 환경변수 `GEOCODING_PROVIDER=nominatim`으로 명시적으로 활성화한다. 공공 Nominatim 정책은 개발자의 사전 판단 없는 자동 생성 범용 검색 서비스를 허용하지 않는다. 활성화 전 [Nominatim 이용 정책](https://operations.osmfoundation.org/policies/nominatim/)을 반드시 확인한다. 검색어에 개인정보나 기밀을 넣으면 안 된다.
- 선택 기능을 켜도 알려진 지역 이름은 로컬에서 처리한다. 나머지 검색어는 검색 버튼/Enter 제출 때만 Nominatim으로 전달한다. 자동완성 호출은 하지 않는다. 단일 서버 프로세스에서 요청을 직렬화하고 초당 1회 이하로 제한하며 성공 결과는 24시간, 오류 결과는 60초 동안 최대 512개까지 캐시한다. 앱 식별 User-Agent, 5초 HTTP 타임아웃, 대한민국 필터를 사용한다. 여러 프로세스·서버를 쓰는 운영 환경에는 공유 제한기가 없으므로 공공 공급자를 활성화하지 않는다. `GEOCODING_PROVIDER=local`로 외부 검색을 즉시 끌 수 있다.
- [Nominatim Search API](https://nominatim.org/release-docs/latest/api/Search/): `jsonv2`, `countrycodes=kr`, `accept-language=ko`, `limit=5`를 사용한다. API 경계상자 순서 `[남, 북, 서, 동]`은 앱의 `[서, 남, 동, 북]`으로 바꾼다. 외부 검색 결과에는 [OpenStreetMap 기여자·ODbL 출처](https://www.openstreetmap.org/copyright)를 표시한다.


## 실제 수면(저수지·호수) 경계

- ‘이 지역 수면 찾기’는 사용자가 버튼을 누를 때만 보이는 지도 범위(최대 경도 0.8° × 위도 0.6°, 0.1° 격자로 확장)를 공개 [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)(overpass-api.de, maps.mail.ru 동시 요청 후 먼저 온 응답 사용)로 보낸다. 검색어·프로젝트 정보는 보내지 않는다.
- 대상: `natural=water`, `landuse=reservoir`. 하천·수로(`water=river|canal|stream|ditch|drain|moat|wastewater|lock` 등)는 제외하고 1 ha 이상만 남긴다. 섬은 폴리곤 구멍으로 유지해 배치에서 빠진다.
- 경계는 OpenStreetMap 기여자 지도 자료([ODbL](https://www.openstreetmap.org/copyright))이며 측량 수면이 아니다. 수위에 따라 실제 수면 면적이 달라진다.
- 결과는 서버 메모리(24시간)와 `backend/data/water-cache`(30일)에 캐시한다. 공용 서버는 혼잡할 때 첫 조회에 30초~1분이 걸리거나 실패할 수 있다. `WATER_PROVIDER=off`로 끌 수 있다.

## 카카오 장소·주소 검색 (선택)

- `GEOCODING_PROVIDER=kakao`와 `KAKAO_REST_API_KEY`를 설정하면 시·군 이름이 아닌 검색어(아파트·건물·도로명 주소 등)를 [카카오 로컬 API](https://developers.kakao.com/docs/latest/ko/local/dev-guide) 키워드 검색으로, 결과가 없으면 주소 검색으로 조회한다. 키는 서버 환경변수에만 둔다.
