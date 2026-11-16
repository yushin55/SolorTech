# Render 배포용 백엔드 이미지 (빌드 컨텍스트: 레포 루트)
# 비공개 데이터 레포의 K-water·기상청 원본 자료로 import_data → build_calibration을 빌드 중에
# 실행해 가공 자료와 보정 모델만 이미지에 넣는다. 원본은 같은 단계에서 지워 레이어에도 남지 않는다.
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY backend/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir -r requirements.lock

COPY backend/app ./app
COPY backend/scripts ./scripts

# 원본 자료(K-water 실적·기상청 관측)는 공개 코드 레포에 두지 않고 비공개 데이터 레포에서 받는다.
#  - Render 환경변수 DATA_REPO = "소유자/레포" (빌드 인자로 전달됨, 비밀 아님)
#  - Render Secret File "data_token" = 데이터 레포 읽기 전용 GitHub 토큰
#    (BuildKit 시크릿으로만 마운트되어 이미지에 남지 않는다)
ARG DATA_REPO
RUN --mount=type=secret,id=data_token,required=true \
    python scripts/fetch_data.py "$DATA_REPO" /run/secrets/data_token /raw \
 && mkdir -p /app/data \
 && python scripts/import_data.py /raw \
 && (python scripts/build_calibration.py \
     || echo "WARNING: 보정 모델 생성 실패 - 물리 모델만으로 실행됩니다") \
 && rm -rf /raw

EXPOSE 8000
# Render는 PORT 환경변수를 넘겨준다. 없으면 8000.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
