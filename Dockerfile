# APEX Registry Server Dockerfile
FROM node:20-alpine AS builder

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy source
COPY . .

# Build
RUN npm run build

# Prune dev dependencies
RUN npm prune --omit=dev

# Production image
FROM node:20-alpine

WORKDIR /app

# Copy package.json for reference
COPY package*.json ./

# Copy node_modules from builder (already pruned to production only)
COPY --from=builder /app/node_modules ./node_modules

# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin

# Create data directories
RUN mkdir -p /app/data/packages

# Set environment
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
ENV DATABASE_PATH=/app/data/apex.db
ENV STORAGE_PATH=/app/data/packages

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

# Start server
CMD ["node", "dist/cli.js"]
