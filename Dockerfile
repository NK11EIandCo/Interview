FROM node:20-slim AS build

WORKDIR /app

# Build frontend
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci
COPY frontend ./frontend
RUN cd frontend && npm run build

# Build server
COPY server/package*.json ./server/
RUN cd server && npm ci
COPY server ./server
RUN cd server && npm run build

FROM node:20-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies for the server
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# Copy built artifacts
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/frontend/dist ./frontend/dist

EXPOSE 3000
CMD ["node", "server/dist/index.js"]
