# Build stage
FROM node:22-slim AS builder

# Install system dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    libssl-dev \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies with yarn
RUN yarn install --frozen-lockfile

# Copy source code
COPY . .

# Generate Prisma Client
RUN yarn prisma generate

# Build the application
RUN yarn build

# Production stage
FROM node:22-slim AS production

# Install runtime dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    libssl-dev \
    openssl \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./

# Install production dependencies only
RUN yarn install --frozen-lockfile --production

# Copy prisma schema and generate client for runtime
COPY --from=builder /app/prisma ./prisma
RUN yarn prisma generate

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "dist/main"]
