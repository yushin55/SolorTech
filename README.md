# 수면 SOOMYEON · 수상태양광 사업성 검토

수상태양광 신규 후보지의 월별 발전량을 **K-water 운영실적으로 검증·보정**하고, 그 발전량을 **K-water 「태양광에너지 표준설계모델 가이드라인」 개략공사비 산정 Tool 절차**(설치대상지 → 기자재 → 설치용량·발전량 → 개략공사비 → 예상수익 → 재무성·에너지 대체효과)에 연결해 B/C·필요 판매단가를 비교하는 한국어 로컬 웹 도구다. **React + Vite + TypeScript 프론트엔드**와 **Python FastAPI 백엔드**로 구성한다.

v2부터 합성 기상·가상 후보지는 쓰지 않는다. 발전량은 ERA5 재분석 시간자료(Open-Meteo)로 pvlib을 계산하고, 아산정수장 2차발전설비와 정산내역 26개 발전소의 실적으로 장소 분리 검증한 보정 모델을 적용한다. 인증 없는 **로컬 단일 사용자 MVP**이며 공개 서비스 배포용 구성이 아니다.

## 빠른 실행 · Windows PowerShell

Python 3.11과 Node.js 22.13 이상(또는 24 이상)을 준비한다. 개발 시 확인한 버전은 Python 3.11.9 / Node.js 22.19.0 / npm 10.9.3이다. 아래 명령은 이 저장소 루트에서 시작한다.

첫 번째 터미널 — 백엔드:

```powershell
python -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.lock
cd backend
# 최초 1회: K-water 실적·기상청 자료 가져오기 + 보정 모델 생성 (아래 ‘데이터 출처’ 참고)
.venv/Scripts/python.exe scripts/import_data.py "C:/Users/user/Desktop/AI 기후테크/solar model/v1_official_pipeline/data/raw"
.venv/Scripts/python.exe scripts/build_calibration.py
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

두 번째 터미널 — 프론트엔드:

```powershell
cd frontend
npm.cmd ci
npm.cmd run dev
```

접속 주소:

- 화면: <http://localhost:5174>
- API 문서: <http://127.0.0.1:8000/docs>
- API 상태·저장 방식: <http://127.0.0.1:8000/api/health>

백엔드 첫 실행 시 OSM 수면 경계(예당저수지·탑정호)와 아산정수장 실적 재현 후보지가 있는 시작 프로젝트를 만든다. **분석 실행** 또는 **대안 비교 → 전체 대안 분석**을 누르면 실제 계산을 시작한다. 화면 새로고침·서버 재시작 후에도 입력과 완료된 분석은 유지된다. 터미널의 `Ctrl+C`로 종료한다.

macOS/Linux에서는 가상환경 실행 경로를 `backend/.venv/bin/python`으로 바꾸고 `npm`을 사용한다. 이 환경에서는 Windows 로컬 실행을 검증했다.

홈 화면에서 `504 (Outdated Optimize Dep)` 또는 `Failed to fetch dynamically imported module`이 발생하면 프론트엔드 터미널을 `Ctrl+C`로 종료한 다음 아래 명령으로 의존성 캐시를 다시 생성하고 브라우저를 `Ctrl+Shift+R`로 새로고침한다.

```powershell
npm.cmd --prefix frontend run dev -- --force
```

개발 서버와 테스트는 각각 `frontend/node_modules/.vite-dev`, `frontend/node_modules/.vite-test`에 캐시를 저장한다. 개발 서버가 실행 중일 때 `node_modules`나 `.vite-dev`를 삭제하거나 `npm ci`를 실행했다면 프론트엔드를 다시 시작한다. [Vite 공식 캐시 안내](https://vite.dev/config/shared-options#cachedir)를 참고한다.

## VS Code에서 F5로 백엔드 실행

VS Code에서 이 저장소의 **`solar` 폴더를 열고 `F5`**를 누르면 **백엔드: FastAPI (F5)** 구성이 실행된다. Python과 Python Debugger 확장을 설치해야 하며, 저장소의 추천 확장 목록에도 등록했다. 가상환경과 패키지는 위의 빠른 실행 명령으로 처음 한 번 준비한다.

- API 주소: <http://127.0.0.1:8000>, API 문서: <http://127.0.0.1:8000/docs>
- Python 파일 저장 시 자동 재시작하며 중단점 디버깅을 지원한다. 종료는 **`Shift+F5`**다.
- Firebase 등 별도 설정이 필요하면 저장소 루트의 `.env`에 작성한다. F5 실행 시 이 파일을 읽으며, 파일이 없으면 기본 SQLite 설정을 사용한다. 로컬 Firestore 에뮬레이터 주소는 `127.0.0.1:8080`이다.
- 프론트엔드는 별도 터미널에서 `npm.cmd --prefix frontend run dev`로 실행한다. 기존 백엔드가 8000번 포트에서 실행 중이면 먼저 해당 터미널에서 종료한다.

설정은 [.vscode/launch.json](.vscode/launch.json)에 있다. `backend/.venv`를 사용하며 macOS/Linux용 실행 경로도 포함했다. VS Code 디버깅 설정 형식은 [공식 Python 디버깅 문서](https://code.visualstudio.com/docs/python/debugging)를 따른다.

## Docker Compose

Docker Desktop과 Compose 2.20 이상이 필요하다. 모든 공개 포트는 호스트 `127.0.0.1`에 연결한다.

```powershell
Copy-Item .env.example .env
docker compose up --build
```

기본값은 SQLite이며 화면·API 주소는 위와 같다. DB는 `solar-data` 볼륨에 보존한다. 정상 종료는 `docker compose down`이다. 이 작업 환경에는 Docker 실행 파일이 없어 **컨테이너 빌드·실행은 검증하지 못했다**. 제공한 소스의 네이티브 실행·테스트 기록은 [검증 기록](docs/verification.md)을 참고한다.

Firestore 에뮬레이터로 실행하려면 `.env`의 다음 두 항목을 수정한 뒤 실행한다.

```dotenv
STORAGE_BACKEND=firestore
FIRESTORE_EMULATOR_HOST=firebase:8080
```

```powershell
docker compose --profile firebase up --build
```

Firebase UI는 <http://127.0.0.1:4000>이다. 프로젝트 ID는 `demo-solar-local`이며 서버와 에뮬레이터가 같은 ID를 사용해야 한다. 에뮬레이터 데이터는 정상 종료 시 내보내고 다음 시작 때 복원한다. 강제 종료 시 마지막 내보내기 이후 변경은 보존되지 않을 수 있다.

## Firebase 연결

React 화면 → FastAPI API → 저장소 어댑터 → Firestore 순서로 접근한다. Firebase 비밀키는 서버에서만 사용하며 브라우저로 전달하지 않는다. `firestore.rules`는 클라이언트 직접 접근을 거부한다. 규칙은 서버 Admin SDK 권한이나 FastAPI 인증을 대신하지 않는다.

Docker 없이 로컬 에뮬레이터를 사용할 수도 있다. Java JDK와 Node.js를 준비하고 저장소 루트의 별도 터미널에서 실행한다. CLI 버전은 14.19.1로 고정했다. Firebase 로그인이나 실제 클라우드 프로젝트는 필요하지 않다.

```powershell
npx.cmd firebase-tools@14.19.1 emulators:start --only firestore --project demo-solar-local --export-on-exit=./.firebase-data
```

이후 다시 시작할 때 `.firebase-data/firebase-export-metadata.json`이 있으면 `--import=./.firebase-data`를 추가한다. 백엔드를 실행할 터미널에서는 다음 환경변수를 설정한다.

```powershell
$env:STORAGE_BACKEND = "firestore"
$env:FIREBASE_PROJECT_ID = "demo-solar-local"
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
cd backend
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

자신의 실제 Firestore를 연결할 경우 Firebase 프로젝트에 Firestore 데이터베이스를 준비하고, 서버 계정 JSON을 저장소 밖에 보관한다. 별도의 로컬 백엔드 터미널에서 다음처럼 설정한다.

```powershell
$env:STORAGE_BACKEND = "firestore"
$env:FIREBASE_PROJECT_ID = "your-project-id"
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:/secure/firebase-service-account.json"
Remove-Item Env:FIRESTORE_EMULATOR_HOST -ErrorAction SilentlyContinue
```

그 뒤 위와 같이 `127.0.0.1`에서 백엔드를 실행한다. 로컬 에뮬레이터의 CRUD·실제 분석·청크 저장·재접속 보존은 검증했다. 사용자 계정·키가 제공되지 않아 실제 클라우드 Firestore 쓰기는 검증하지 않았다. `.env`는 Compose가 읽으며, 네이티브 실행에서는 위 PowerShell 환경변수를 사용한다. 저장 방식을 전환해도 기존 자료를 자동 이관하지 않는다.

| 환경변수 | 기본값 / 용도 |
| --- | --- |
| `STORAGE_BACKEND` | `local` 또는 `firestore`; 명시적으로 선택 |
| `LOCAL_DB_PATH` | 기본 `backend/data/solar.sqlite3`; Compose는 `/app/data/solar.sqlite3` |
| `SEED_DEMO` | `true`; 최초 저장소에서만 데모 초기화 |
| `FIREBASE_PROJECT_ID` | Firestore 프로젝트 ID; 에뮬레이터는 `demo-solar-local` |
| `FIRESTORE_EMULATOR_HOST` | 에뮬레이터 `host:port`; `http://`를 붙이지 않음 |
| `GOOGLE_APPLICATION_CREDENTIALS` | 실제 Firestore용 서버 계정 JSON 절대경로 |
| `FIRESTORE_COLLECTION_PREFIX` | `solar_`; 컬렉션 이름 접두사 |
| `CORS_ORIGINS` | `http://localhost:5174,http://127.0.0.1:5174` |
| `API_PROXY_TARGET` | Vite API 프록시; 로컬 기본 `http://127.0.0.1:8000`, Compose는 `http://backend:8000` |

## 사용 흐름

1. **운영실적 데이터**에서 K-water 발전소 27곳(아산정수장 2차발전설비 일 발전량 + 정산내역 26곳 일 전력거래량)의 품질 점검 결과와, 같은 날짜의 실제 기상으로 계산한 물리 모델 값을 확인한다.
2. **기상 관측 검증**에서 ERA5 일사량과 기상청 서울 ASOS 일사계 관측의 일치도, 월별 보정계수와 채택 여부, 기상청 천안 평년값(1991~2020)을 확인한다.
3. **보정 모델 검증**에서 발전소를 하나씩 빼고 학습해 예측하는 장소 분리 검증(leave-one-plant-out) 결과, 선택된 보정 모델, 신규 후보지에 붙는 오차 범위(P10–P90)의 근거를 확인한다.
4. **사업성 검토**에서 지도 검색 → **이 지역 수면 찾기**로 OSM 저수지·호수 경계를 후보지로 추가한다. 오른쪽 패널에서 가이드라인 단계별 조건(① 대상지 · ② 기자재 · ④ 공사비 · ⑤⑥ 수익·재무)을 입력하고 **분석 실행**을 누른다.
5. 결과는 가이드라인 부록 「개략공사비 산정 Tool」의 6단계(① 설치대상지 선정 → ② 부지면적·기자재 → ③ 설치용량·연간발전량 → ④ 개략공사비 → ⑤ 예상수익 → ⑥ 재무성 분석·에너지 대체효과) 순서로 표시된다. ⑥에는 B/C·NPV·IRR 외에 **필요 판매단가(B/C = 1)** 와 **발전량이 검증 하한(P10)·−5%·−10%일 때의 B/C**가 함께 나온다.
6. **후보지 비교**에서 여러 대안을 같은 기준으로 비교하고, **검토 보고서**로 인쇄·PDF 저장하거나 결과 CSV를 내려받는다.
7. **실적 CSV 대조**에 새 발전소 계량 CSV를 올리면, 업로드된 날짜의 실제 기상으로 선택한 설계안을 다시 계산해 월별 오차를 보여준다.

시작 프로젝트 「K-water 실적 기반 수상태양광 검토」에는 예당저수지·탑정호(OSM 수면 경계)와 **아산정수장 2차발전설비 실적 재현** 후보지가 들어 있다. 아산 후보지는 경계 없이 설비용량(2,131 kWp)으로 재현하며, 아산을 학습에서 뺀 모델의 예측을 실적과 나란히 보여준다.

처음 분석하는 위치는 30년치(1991~2020) 기상자료를 내려받느라 1분가량 걸린다. 이후에는 `backend/data/weather-cache`의 캐시를 사용한다.

## 데이터 출처

| 자료 | 내용 | 위치 |
| --- | --- | --- |
| 아산정수장 월간보고서 (`월간보고서_YYYYMM.xls`, HTML 형식) | 2,132.1 kWp, 인버터 전체 일 발전량 2023-04~2026-07 (일부 월 결측) | 원본 폴더 → `backend/data/kwater/daily.csv` |
| 발전원별 정산내역(전체).xlsx | 26개 발전소 일 전력거래량 2023-01~2026-07, 시설용량 | 〃 |
| 기상청API_지상관측데이터_일통계_202304_202608.csv | ASOS **서울(108)** 일 기온·습도·운량·일조·**일사(SI, MJ/m²)** 2023-04-01~2026-08-31, 1,249일 | `backend/data/kma/asos_daily.csv` |
| 기상청API_평년값_천안관측소_1991_2020.csv | 천안(232) 월별 평년값: 기온·최고·최저·습도·일조시간 (운량 결측) | `backend/data/kma/normals_monthly.csv` |
| Open-Meteo Historical Weather API (ECMWF ERA5, CC BY 4.0) | 시간별 GHI·DNI·DHI·기온·풍속. 키 불필요 | `backend/data/weather-cache` |
| OpenStreetMap (ODbL) | 수면 경계(Overpass), 발전소 위치 지오코딩(Nominatim) | `backend/data/water-cache`, 등록부 좌표 |
| K-water 태양광에너지 표준설계모델 가이드라인 | 최적경사각·계절 경사각·이격거리·직렬 수·인버터·접속반·계통연계·모듈 단가·에너지 대체효과 | `backend/app/engine/guideline.py` (표 번호 주석) |

합성 기상·가상 후보지·합성 예제 CSV는 v2에서 모두 제거했다. 시간별 기상은 전국을 덮는 ERA5 재분석을 쓰고, 기상청 ASOS 일사계 관측으로 그 일사량을 검증·보정한다(‘기상 관측 검증’). 일통계 파일은 이름과 달리 천안이 아닌 **서울(108)** 관측소 자료다. 천안 ASOS는 일사계가 없을 수 있으니 일사 관측소(예: 대전·청주)를 추가하면 지역별 보정으로 바꿀 수 있다.

### 자료 가져오기와 보정 모델 재생성

원본 폴더가 바뀌면 `backend`에서 다음을 순서대로 실행한다. 원본 파일은 읽기만 한다.

```powershell
.venv/Scripts/python.exe scripts/import_data.py "C:/Users/user/Desktop/AI 기후테크/solar model/v1_official_pipeline/data/raw"
.venv/Scripts/python.exe scripts/build_calibration.py
```

`backend/data/`는 `.gitignore` 대상이다. 다른 PC·컨테이너에서는 위 두 명령을 다시 실행하거나 `backend/data/kwater`와 `weather-cache`를 복사한다.

## 계산 방법과 가정

### 운영실적 품질 점검

- 일 0 kWh는 정지·통신 장애, 일 7.5 kWh/kWp 초과는 계량 몰아치기(급등)로 보고 제외한다. 아산 자료에는 하루 374,650 kWh 같은 급등일이 5일 있다.
- 월별 비교는 유효일 80% 이상인 월만, **같은 날짜의 물리 모델 값**과 비교한다.
- 발전소 자체 중앙값의 65% 미만인 월은 부분 정지 의심으로 제외한다.
- 실측÷물리 비율이 전체 중앙값의 75% 미만인 발전소는 제원 확인 전까지 학습·검증에서 제외하고 화면에 명시한다. 현재 **청주(정)태양광**(0.64, 중앙값 0.91)이 해당하며, 거래량이 소내 사용분을 뺀 값이거나 음영·용량 차이일 가능성이 있다.
- 거래량(정산)과 발전량(계량)은 다른 양이다. 26곳은 거래량, 아산은 발전량이다.
- 발전소 좌표는 시설·행정구역 지오코딩(±수 km)이고, 경사·방위는 원본에 없어 가이드라인 지역별 최적경사각·정남향으로 가정했다. 유형은 이름으로만 분류했다(수상 4곳: 합천#2·보령·충주·충주댐#3). 제안서의 "수상 7개소"와 차이가 있으므로 K-water 설비 제원을 받으면 `backend/app/kwater.py` 등록부를 고쳐 다시 실행한다.

### 발전량: 물리 모델 + 운영실적 보정

1. 후보지 격자의 1991~2020년(기상청 평년 기간, 가이드라인 3.5.1의 30년 평균) 시간별 ERA5를 기상청 일사 보정계수로 고친 뒤 연도별 pvlib 계산, 월별 평균. `WEATHER_YEARS=N`이면 최근 N년을 쓴다.
2. 1 kWp·표준 손실(14%·인버터 96%) 기준 물리값에 보정 모델의 실측÷물리 비율을 곱해 설비용량으로 환산한다.
3. 보정 모델 후보: 물리 단독 / 월별 실적비 중앙값 / GBR(월·위치·용량·유형·일사·기온) / GBR + 수상 발전소 잔차 보정(2단계, 수상 발전소끼리 중첩 장소 분리로 산정). **수상 발전소 장소 분리 월 MAPE가 가장 낮고 물리 단독보다 나은 모델**을 선택하며, 개선이 없으면 물리 모델을 유지한다.
4. 오차 막대(P10–P90)는 선택 모델의 장소 분리 검증에서 나온 실측÷예측 비율 분포다.

### 기상청 일사 보정

ERA5 일 GHI를 기상청 서울 ASOS 일사계(1,244일)와 비교하면 일별 상관 0.934, 전체 기간 치우침 +0.8%로 거의 맞지만, 7·8월은 ERA5가 13~15% 높고 4·5월은 6~7% 낮다. 달력 월별 보정계수(관측÷ERA5)를 만들어 물리 입력에 곱한 경우와 그대로 쓴 경우를 **각각 장소 분리 검증**했고, 선택 모델의 수상 월 MAPE가 7.29% → 7.15%로 줄어 보정을 채택했다(`build_calibration.py`가 자동 판정). 물리 모델 단독은 오히려 10.0% → 10.9%로 나빠지므로, 보정은 실적 보정 모델과 함께 쓸 때만 이득이다. 관측소가 서울 1곳이라 같은 계수를 전국에 적용한다.

### 검증 결과

현재 결과(2023-01~2026-07, 기상청 보정 입력, 학습·검증 1,037개월):

| 모델 | 전체 MAPE / 편향 | 수상 MAPE / 편향 |
| --- | --- | --- |
| 물리 모델 단독 | 16.1% / +14.2% | 10.9% / +7.7% |
| 월별 실적비 중앙값 | 10.7% / +3.8% | 8.5% / −2.3% |
| GBR | 10.3% / +1.6% | 7.4% / −2.4% |
| **GBR + 수상 잔차 (선택)** | 10.3% / +2.4% | **7.1%** / +2.9% |

연간 오차 범위 P10–P90은 실측÷예측 0.91~1.09다. 수상 발전소가 4곳뿐이므로 수상 지표는 표본이 작다.

### 가이드라인 단계별 산정

- ① 경사각: 50 km 이내 K-water 정수장이 있으면 표 3-19(프로그램 최적경사각), 없으면 표 3-18(자원지도). 가변형은 표 3-21 계절 경사각(없으면 표 3-20 이론식)으로 계절마다 따로 계산한다. 풍속·적설·지진은 표 3-4.
- ② 모듈은 표 3-9(수상 450 Wp 225,000원 / 육상 480 Wp 230,400원). 이격거리 X = L(cos α + sin α / tan 23°)(표 3-22). 직렬 수는 −30°C·70°C, MPPT 550~830 V, Voc 1,000 V(표 3-13, 480 Wp 예시 제원 기본값). 인버터는 표 3-12 원칙(멀티구성, 단일이 20% 넘게 싸면 단일)과 구매비, 접속반은 표 3-14, 계통연계는 표 3-5.
- ④ 공사비 = 모듈 + 인버터 + (접속반) + 부유체 + 계류 + 전기 + 수중·연계 케이블(한전 접속점 거리 × 단가) + 토목 + 설계·인허가 + 계통연계. **부유체·계류·전기·토목·설계·계통·유지관리 단가는 가이드라인에 없어 화면에 ‘견적 가정’으로 표시**한다. 인버터 교체비는 표 3-12 구매비를 교체 연차에 1회 반영한다.
- ⑤ 발전용은 고정가격 또는 SMP+REC, 소내소비용은 소내 사용분 × 전력 단가 + 잉여 판매(부록 2.6).
- ⑥ B/C = 유입 현재가치 ÷ 유출 현재가치, NPV·IRR·단순 회수기간. 필요 판매단가 = 유출 현재가치 ÷ 할인 판매전력량. 연말 세전 비차입 현금흐름이며 금융·세금·물가·잔존가치는 제외. 에너지 대체효과 계수(가구당 4,347.8 kWh, 0.25 TOE/MWh, 0.47 tCO₂/MWh, 소나무 0.07065그루/kWh)는 부록 표 1-1 예시값에서 역산했으며 세 예시 행을 모두 재현한다.

개략 배치는 후보지 기준점 주변에 가이드라인 이격거리로 모듈 블록을 놓는다. 구조·계류 안전성이나 인허가를 검증한 상세 설계가 아니다.

## 실적 CSV 대조

**실적 CSV 대조**에서 완료된 분석을 선택하고 CSV 미리보기 → 열 매핑 → 단위·계량 종류·구간 의미 설정 → 검증 순서로 진행한다. 업로드된 날짜(최대 5개 연도)의 ERA5 시간자료로 설계안을 다시 계산하고, 분석이 보정 기준이면 월별 보정계수를 곱해 같은 시각끼리 비교한다.

UTF-8(BOM 포함)·CP949, 최대 5 MB·100,000행·100열을 허용한다. 중복·결측·음수·용량 대비 비정상 값, 누적 계량 리셋·시간 공백을 점검하며, 상대오차는 월 유효 구간 80% 이상·실적 0 초과·위치·설비 메타데이터 일치 조건에서만 계산한다. 원본 CSV와 가공 결과는 별도 레코드로 저장한다.

## 폴더와 저장 구조

```text
frontend/src/App.tsx          화면 골격·후보지/대안 관리·비교·보고서
frontend/src/Steps.tsx        가이드라인 6단계 결과·월별 발전량(오차 막대)·실적 재현
frontend/src/Records.tsx      운영실적 데이터·보정 모델 검증 화면
frontend/src/Editors.tsx      단계별 설계 입력(출처 배지)·후보지 입력
backend/app/main.py           프로젝트·후보지·대안·실행·실적·보정·가이드라인 API, v1→v2 이관
backend/app/kwater.py         K-water 원본 파서·발전소 등록부·일 품질 점검
backend/app/weather.py        Open-Meteo ERA5 시간자료 다운로드·캐시
backend/app/calibration.py    물리 vs 실측 데이터셋·장소 분리 검증·보정 모델 적용
backend/app/engine/guideline.py  표준설계모델 가이드라인 표·규칙
backend/app/engine/           energy(pvlib)·finance·geometry·analysis(6단계 조립)
backend/app/seed.py           시작 프로젝트(OSM 수면 + 아산 재현)
backend/scripts/              import_data.py, build_calibration.py
backend/app/kma.py            기상청 ASOS 일통계·평년값 파서, 일사 검증·평년 기후 비교
backend/data/                 SQLite, kwater/, weather-cache/, water-cache/ (gitignore)
```

논리 관계는 `프로젝트 → 후보지 → 설계 대안 → 분석 실행 → 결과`다. 서버 시작 시 v1 저장소를 한 번 이관한다: 합성 기상으로 계산한 v1 분석 실행과 가상 후보지(가상 수면 A·B)를 지우고, 사용자가 추가한 후보지(예: 간월호)는 남겨 v2 기본 설계로 바꾼다.

## 구현 범위와 한계

- 시간별 기상은 ERA5 재분석이다. 기상청 일사 관측은 서울 1곳뿐이라 보정계수가 전국 공통이다. 평년값은 천안 1곳으로, 60 km 이내 후보지만 ① 단계에서 기온을 비교한다.
- 평년 일조시간은 참고용이다. ERA5 시간 평균값으로는 일조시간을 재현할 수 없어 비교하지 않는다.
- 팀의 Ridge·RandomForest 실험(`solar model/v1_official_pipeline`)은 일 단위 품질 점검 없이 월 합계를 학습해 검증 MAPE 74~86%였다. 이 도구의 보정 모델에는 쓰지 않았다.
- 보정 모델은 거래량 26곳 + 발전량 1곳으로 학습했다. 수상은 4곳이다. 발전소 경사·방위·좌표는 가정값이므로 설비 제원을 받으면 정확도가 달라질 수 있다.
- 2026년처럼 진행 중인 연도의 기상 캐시는 날짜가 붙은 이름으로 저장되며, 다른 날 다시 실행하면 새로 내려받는다.
- 부유체·계류·전기·토목·유지관리 단가는 사용자 견적 가정이다. REC 가중치는 고시를 확인해 입력한다.
- 사용자 인증·공개 호스팅·세금/대출 모델·구조/계류 해석은 범위 밖이다.

테스트·빌드:

```powershell
cd backend
.venv/Scripts/python.exe -m pytest -q
```

```powershell
cd frontend
npm.cmd test
npm.cmd run build
```

가이드라인 표 3-12(인버터 구성)·3-13(직렬 수)·3-23(이격거리)·부록 에너지 대체효과 예시는 테스트로 재현을 확인한다. 엔진 테스트의 기상 입력은 저장소에 캐시된 실제 ERA5 연도를 쓰며, 캐시가 없으면 해당 테스트를 건너뛴다.
