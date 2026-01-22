# ======================
# Build stage
# ======================
FROM node:22-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    libssl-dev \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json yarn.lock ./

# ⚠️ BẮT BUỘC: dùng npm registry + clean cache
RUN yarn config set registry https://registry.npmjs.org \
 && yarn cache clean --all \
 && yarn install --frozen-lockfile

COPY . .

RUN yarn prisma generate
RUN yarn build


# ======================
# Production stage
# ======================
FROM node:22-slim AS production

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    libssl-dev \
    openssl \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Prisma schema needed for postinstall prisma generate
COPY --from=builder /app/prisma ./prisma

COPY package.json yarn.lock ./

# ⚠️ QUAN TRỌNG NHẤT
RUN yarn config set registry https://registry.npmjs.org \
 && yarn cache clean --all \
 && yarn install --frozen-lockfile --production

# App build
COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/main.js"]
