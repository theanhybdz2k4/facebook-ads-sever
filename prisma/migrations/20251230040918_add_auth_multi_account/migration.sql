/*
  Warnings:

  - You are about to drop the column `account_id` on the `fb_api_tokens` table. All the data in the column will be lost.
  - You are about to drop the column `user_id` on the `fb_api_tokens` table. All the data in the column will be lost.
  - Added the required column `fb_account_id` to the `fb_api_tokens` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "fb_api_tokens" DROP CONSTRAINT "fb_api_tokens_account_id_fkey";

-- DropIndex
DROP INDEX "fb_api_tokens_account_id_idx";

-- AlterTable
ALTER TABLE "ad_accounts" ADD COLUMN     "fb_account_id" INTEGER;

-- AlterTable
ALTER TABLE "fb_api_tokens" DROP COLUMN "account_id",
DROP COLUMN "user_id",
ADD COLUMN     "fb_account_id" INTEGER NOT NULL,
ADD COLUMN     "is_default" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "name" TEXT;

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fb_accounts" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "fb_user_id" TEXT,
    "name" TEXT,
    "is_valid" BOOLEAN NOT NULL DEFAULT true,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "fb_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "fb_accounts_user_id_idx" ON "fb_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "ad_accounts_fb_account_id_idx" ON "ad_accounts"("fb_account_id");

-- CreateIndex
CREATE INDEX "fb_api_tokens_fb_account_id_idx" ON "fb_api_tokens"("fb_account_id");

-- AddForeignKey
ALTER TABLE "fb_accounts" ADD CONSTRAINT "fb_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fb_api_tokens" ADD CONSTRAINT "fb_api_tokens_fb_account_id_fkey" FOREIGN KEY ("fb_account_id") REFERENCES "fb_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_fb_account_id_fkey" FOREIGN KEY ("fb_account_id") REFERENCES "fb_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
