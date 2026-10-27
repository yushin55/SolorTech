# Render 배포용 백엔드 이미지 (빌드 컨텍스트: 레포 루트)
# 레포 루트의 K-water·기상청 원본 자료로 import_data → build_calibration을 빌드 중에 실행해
# 보정 모델을 이미지에 포함한다. 로컬 PC에서 데이터를 따로 만들어 커밋할 필요가 없다.
FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY backend/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir -r requirements.lock

COPY backend/app ./app
COPY backend/scripts ./scripts

# 원본 자료 (읽기 전용으로만 사용)
COPY ["아산 태양광 발전량", "/raw/아산 태양광 발전량"]
COPY 발전원별*.xlsx 기상청API_*.csv /raw/

RUN mkdir -p /app/data \
 && python scripts/import_data.py /raw \
 && (python scripts/build_calibration.py \
     || echo "WARNING: 보정 모델 생성 실패 - 물리 모델만으로 실행됩니다")

EXPOSE 8000
# Render는 PORT 환경변수를 넘겨준다. 없으면 8000.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
