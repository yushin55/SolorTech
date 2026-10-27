> **v1 기록입니다.** 아래 내용은 합성 기상·가상 후보지를 쓰던 v1 검증 기록입니다. v2(K-water 운영실적 보정·ERA5·가이드라인 6단계)의 검증 방법과 결과는 [README](../README.md)의 ‘계산 방법과 가정’에 있습니다.

# 기능 검증 기록

검증일: 2026-10-17 (Asia/Seoul). 기준 환경: Windows PowerShell, Python 3.11.9, Node.js 22.19.0, npm 10.9.3.

## 확인한 항목

| 항목 | 결과 | 근거 |
| --- | --- | --- |
| 예제 CSV 재생성 | 통과 | `python examples/generate_examples.py` 종료 코드 0 |
| 예제 CSV 형식·행 수 | 통과 | UTF-8 BOM·영문 헤더, 시작/종료 표기 각각 744행, 누적 경계·리셋 48행, 오류 샘플 6행 |
| Firebase 설정 구문 | 통과 | `firebase.json`을 표준 JSON 파서로 읽음 |
| 라이브러리 공식 문서 | 확인 | [references.md](references.md)에 원문과 호환성 기준 기록 |
| 계산 엔진 단위 검증 | 통과 | 18개 테스트 통과 (개별 항목은 `backend/tests/test_engine.py`) |
| API·저장·CSV 통합 검증 | 통과 | 8개 테스트 통과 / 24.10초 (`backend/tests/test_api.py`) |
| Python 설치 호환성 | 통과 | `pip check` 충돌 없음. 전체 설치 버전 `backend/requirements.lock` 생성 |
| 프론트엔드 정적 검사·빌드 | 통과 | TypeScript 및 Vite 빌드 완료 |
| React 화면 상태 통합 검증 | 통과 | jsdom·Testing Library 기반 5개 테스트. 선택 조사값의 빈값 저장, 제외 경계 이동, 변경 조건 경고, 프로젝트 간 검증 대상 초기화, 분석→복제·수정→비교→보고서 흐름 |
| 지역 검색 API | 통과 | 내장 지역·별칭·전국 보기·좌표·장애·캐시·요청 제한 34개 테스트. 실제 상세 주소 공급자 호출은 기본 비활성 상태로 미실행 |
| 지도 분포 데이터 | 통과 | 색상 구간·범례·단위·선택 대안 우선·입력 변경/누락 회색·범위 계산 24개 테스트 |
| 검색 화면 | 통과 | 제출 시 요청·지역 선택·결과 없음·실패 후 재시도 3개 React 테스트 |
| 실제 지도 라이브러리 동작 | 통과 | Leaflet을 대체하지 않은 jsdom SVG/DOM 테스트 4개. OSM 타일 요소·색상·후보지 클릭·검색 확대·중심점 전달·경계 저장 확인. 실제 브라우저 시각 검증과 구분 |
| 지도 로딩 오류 격리·복구 | 통과 | lazy import 실패·지도 렌더링 실패에도 홈 유지, 다시 불러오기 3개 React 테스트 |
| 실행 중 개발 캐시 보존 | 통과 | 홈페이지·MapView·실제 의존성 URL 9개의 HTTP 200 및 본문 해시를 기록하고, 전체 테스트 실행 후 같은 URL/해시가 유지됨을 확인. `node frontend/scripts/verify-dev-deps.mjs http://127.0.0.1:5174 --with-tests` |
| 검색·배경지도 HTTP | 통과 | 수원·양평·충주·합천·전국·좌표 검색의 Vite 프록시 응답 및 OSM PNG 타일 HTTP 200. [map-search-verification.json](map-search-verification.json) |
| F5 디버그 구성 | 통과 | VS Code launch/settings/extensions JSON 및 설치된 Python Debugger의 debugpy + uvicorn --reload로 health HTTP 200 확인. 실제 키 입력은 미실행 |
| 실제 로컬 HTTP 종단 검증 | 통과 | 프로젝트·후보지·두 대안 생성, 실제 계산·재계산·스냅샷 보존, 744행 CSV 처리, 프로젝트 복제·삭제. [http-workflow-verification.json](http-workflow-verification.json) |
| CSV 예제의 실제 엔진 연계 | 통과 | 가상 수면 A 기본안의 실제 pvlib 결과와 4개 예제를 처리. 세부 결과는 [example-verification.json](example-verification.json) |
| Firestore 에뮬레이터 기동 | 통과 | Java 22.0.2, Firebase CLI 14.19.1, Firestore 에뮬레이터 1.19.8. `demo-solar-review` 프로젝트와 `127.0.0.1:8080` 사용 |
| Firestore 저장 어댑터·API 연계 | 통과 | CRUD·실제 pvlib 실행·스냅샷·깊은 복제·CSV·재접속 보존·연쇄 삭제. [firestore-verification.json](firestore-verification.json) |
| Firestore 대용량 실행 보존 | 통과 | 시간별 8,760개 결과를 포함한 1,081,898바이트 실행 레코드(1 MiB 초과)를 4개 청크로 저장·복원 |
| 로컬 HTTP 서버·프록시 | 통과 | API `127.0.0.1:8000/api/health`, 화면 HTML `localhost:5174`, Vite 경유 `localhost:5174/api/health` 모두 HTTP 200 |

CSV 예제는 구간 시작·종료 파일 각각 744/744개 유효 행과 동일한 1월 전력량을 확인했다. 누적 예제는 첫 기준 행·리셋·시간 공백 각 1개를 제외하여 45/48행이 유효했다. 오류 파일은 6행 모두 제외했다. 짧은 누적·오류 자료의 상대오차는 산정하지 않았다. 이는 업로드 처리 검증이며 실제 발전소 예측 성능을 의미하지 않는다.

현재 Python 전체 테스트 60개와 프론트엔드 테스트 39개가 통과했다(총 99개). 최초 React 작업 흐름 테스트는 지도·차트·API를 격리하며, 지도 런타임 테스트는 실제 Leaflet의 SVG/DOM을 사용한다. jsdom에는 실제 레이아웃·Canvas·브라우저 이미지 표시가 없으므로 실제 브라우저 시각 검증과 구분한다. 별도로 실제 HTTP 서버와 pvlib 엔진을 연결한 두 대안 분석 흐름 및 실제 Firestore 에뮬레이터 저장 흐름을 검증했다. Firestore 검증은 고유한 임시 컬렉션 접두사로 실행하고 자료를 모두 정리했다. 검증 후 해당 에뮬레이터를 종료했으며 실제 클라우드 계정은 사용하지 않았다.

## 실행하지 못한 항목

- **Docker Compose 빌드·기동:** 이 환경에는 `docker` 명령이 설치되어 있지 않다. 네이티브 실행과 별도로 컨테이너 환경 검증이 필요하다.
- **실제 클라우드 Firestore:** 사용자 Firebase 프로젝트·서버 계정 키가 제공되지 않았다. 실제 계정 접근·쓰기·과금 동작을 검증하지 않았다.
- **실제 브라우저 조작·인쇄/PDF 시각 검증:** 연결된 브라우저/앱 목록이 비어 있고 인앱 브라우저 생성 기능을 사용할 수 없어 수행하지 못했다. 정적 빌드 성공은 화면 배치·사용자 클릭 흐름 검증을 대신하지 않는다.
- **실측 정확도·규제·계통·구조 안전 검증:** 실제 현장/발전소 자료와 해당 공공·사업자 데이터가 제공되지 않았다. 합성 자료를 이용한 소프트웨어 검증과 구분한다.

## 재현 명령

```powershell
cd backend
.venv/Scripts/python.exe -m pytest -q
```

```powershell
cd frontend
npm.cmd test
npm.cmd run build
```

Firestore 통합 재현은 먼저 저장소 루트의 다른 터미널에서 아래 에뮬레이터를 기동한다.

```powershell
npx.cmd --yes firebase-tools@14.19.1 emulators:start --only firestore --project demo-solar-review --non-interactive
```

백엔드 터미널:

```powershell
cd backend
$env:FIREBASE_PROJECT_ID = "demo-solar-review"
$env:FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"
.venv/Scripts/python.exe scripts/verify_firestore.py
```

동작 확인 흐름은 프로젝트 생성 → 후보지 저장 → 설계 대안 추가 → 분석 완료 → 대안 복제·조건 수정·재분석 → 월별 발전량·사업성 비교 → CSV·인쇄 보고서 확인이다. 새로고침·서버 재시작 후 결과 보존과 실패/자료 부족 상태도 함께 확인한다.

기존 다른 앱이 5173 포트를 사용하고 있어 본 프로젝트는 **5174**를 사용한다. 기존 앱은 종료하거나 변경하지 않았다.
