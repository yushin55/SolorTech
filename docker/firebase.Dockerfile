FROM node:22.19.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends default-jre-headless && rm -rf /var/lib/apt/lists/*
RUN npm install -g firebase-tools@14.19.1
WORKDIR /app
COPY firebase.json firestore.rules ./
RUN node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('firebase.json','utf8'));for(const k of ['firestore','ui'])c.emulators[k].host='0.0.0.0';fs.writeFileSync('firebase.json',JSON.stringify(c))"
COPY docker/start-firebase.sh /app/start-firebase.sh
EXPOSE 8080 4000
CMD ["sh", "/app/start-firebase.sh"]
