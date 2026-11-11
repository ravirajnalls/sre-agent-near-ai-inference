# SRE Agent web API + UI (server.js serves both).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
# Secrets come from the environment (compose env_file), never from the image.
USER node
EXPOSE 3000
CMD ["node", "server.js"]
