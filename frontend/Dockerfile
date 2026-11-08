# The console as static files (docker-compose.yml `console`). Build context = repo root (it imports contract/).
FROM node:22-bookworm-slim AS build
ARG VITE_STDB_URI=ws://localhost:3000
ARG VITE_STDB_DB=remi
WORKDIR /repo/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY contract /repo/contract
COPY frontend ./
RUN VITE_STDB_URI=$VITE_STDB_URI VITE_STDB_DB=$VITE_STDB_DB npm run build

FROM nginx:1.27-alpine
COPY --from=build /repo/frontend/dist /usr/share/nginx/html
