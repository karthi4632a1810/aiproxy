FROM node:20-bookworm-slim

WORKDIR /app

# Install curl for health checks
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Ensure data directory exists
RUN mkdir -p /app/data

# Default environment configuration
ENV NODE_ENV=production \
    PORT=12345 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    SETUP_TOKEN=aiproxy-setup-token

EXPOSE 12345

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:12345/health || exit 1

CMD ["node", "server.js"]

