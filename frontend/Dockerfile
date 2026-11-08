# The console as static files (docker-compose.yml `console`). Build context = repo root (it imports contract/).
FROM node:22-bookworm-slim AS build
# same-host: the page's own host on :3000, so a browser on another machine on the LAN works too (#83)
ARG VITE_STDB_URI=same-host
ARG VITE_STDB_DB=remi
WORKDIR /repo/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY contract /repo/contract
COPY frontend ./
RUN VITE_STDB_URI=$VITE_STDB_URI VITE_STDB_DB=$VITE_STDB_DB npm run build

FROM nginx:1.27-alpine
COPY --from=build /repo/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
