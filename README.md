# AAMS Backend - Internal Account Asset Management System

Backend API cho hệ thống quản lý tài khoản nội bộ (AAMS).

## Công nghệ sử dụng

- **NestJS** - Framework Node.js
- **TypeScript** - Ngôn ngữ lập trình
- **Prisma** - ORM cho database
- **PostgreSQL** - Database
- **JWT** - Authentication
- **Swagger** - API Documentation
- **Docker** - Containerization

## Cấu trúc dự án

```
src/
├── configs/          # Configuration files
├── constants/        # Constants và enums
├── database/         # Database setup (Prisma)
├── decorators/       # Custom decorators
├── dtos/            # Data Transfer Objects
├── filter-exceptions/ # Exception filters
├── guards/          # Authentication & Authorization guards
├── interceptors/    # Response interceptors
├── models/          # Type definitions
├── modules/         # Feature modules
│   ├── auth/        # Authentication module
│   ├── user/        # User management
│   ├── account/     # Account management (Core)
│   ├── audit-log/   # Audit logging
│   └── notification/ # Notifications
└── utils/           # Utility functions
```

## Yêu cầu hệ thống

- Node.js >= 20
- PostgreSQL >= 13
- Docker & Docker Compose (optional)

## Cài đặt

### 1. Clone repository

```bash
git clone <repository-url>
cd internal-aams-backend
```

### 2. Cài đặt dependencies

```bash
yarn install
```

**Lưu ý:** Dự án này sử dụng **yarn** thay vì npm để resolve peer dependencies tốt hơn.

### 3. Cấu hình môi trường

Tạo file `.env` từ `.env.example`:

```env
# App
PORT=3000
APP_ENV=development
ENABLE_SWAGGER=true
ENABLE_CORS=true

# Database
DB_CONNECTION=postgresql
DB_HOST=localhost
DB_PORT=5432
DB_DATABASE=aams_db
DB_USERNAME=postgres
DB_PASSWORD=postgres
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/aams_db
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/aams_db

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# JWT
ACCESS_TOKEN_SECRET=your-secret-key
ACCESS_TOKEN_EXPIRATION_TIME=3600
REFRESH_TOKEN_SECRET=your-refresh-secret-key
REFRESH_TOKEN_EXPIRATION_TIME=604800

# Email (optional)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USERNAME=your-email@gmail.com
EMAIL_PASSWORD=your-password
EMAIL_FROM_NAME=AAMS System
EMAIL_FROM_ADDRESS=noreply@aams.com

# Frontend
FRONTEND_URL=http://localhost:5173
```

### 4. Setup Database

#### Option 1: Sử dụng Docker

```bash
# Start database only
docker compose -f docker-compose-db-only.yml up -d

# Hoặc start full stack
docker compose up -d
```

#### Option 2: Sử dụng PostgreSQL local

Tạo database:
```sql
CREATE DATABASE aams_db;
```

### 5. Chạy migrations

```bash
# Generate Prisma Client
yarn prisma generate

# Run migrations
yarn prisma migrate dev

# Seed database
yarn prisma db seed
```

### 6. Chạy ứng dụng

```bash
# Development
npm run start:dev

# Production
yarn build
yarn start:prod
```

## API Documentation

Sau khi chạy ứng dụng, truy cập Swagger UI tại:
- http://localhost:3000/swagger

## Default Users

Sau khi seed database, có 2 user mặc định:

**Admin:**
- Email: `admin@aams.com`
- Password: `admin123`

**Staff:**
- Email: `staff@aams.com`
- Password: `staff123`

## Tính năng chính

### 1. Authentication & Authorization
- JWT-based authentication
- Role-based access control (RBAC)
- Permission system

### 2. Account Management
- CRUD operations
- Claim/Release accounts
- Report errors (Die/Checkpoint)
- Import from Excel
- Password encryption
- Status tracking

### 3. Audit Logging
- Track all system actions
- Filter by user, account, action type
- Timestamp and IP tracking

### 4. Notifications
- Expiry warnings
- Account status changes
- Error notifications

### 5. Scheduled Tasks
- Check expiring accounts daily
- Mark expired accounts

## Scripts

```bash
# Development
npm run start:dev

# Build
yarn build

# Production
yarn start:prod

# Linting
yarn lint

# Testing
yarn test

# Prisma
yarn prisma generate      # Generate Prisma Client
yarn prisma migrate dev   # Create migration
yarn prisma db seed       # Seed database
yarn prisma studio        # Open Prisma Studio
```

## Docker Commands

```bash
# Start services
docker compose up -d

# Stop services
docker compose down

# View logs
docker compose logs -f

# Rebuild
docker compose up --build
```

## License

UNLICENSED

