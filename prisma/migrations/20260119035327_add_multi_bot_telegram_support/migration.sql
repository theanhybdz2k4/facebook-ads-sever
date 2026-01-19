/*
  Warnings:

  - You are about to drop the `user_bot_settings` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "user_bot_settings" DROP CONSTRAINT "user_bot_settings_user_id_fkey";

-- DropTable
DROP TABLE "user_bot_settings";

-- CreateTable
CREATE TABLE "telegram_bots" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "platform_account_id" INTEGER,
    "bot_token" TEXT NOT NULL,
    "bot_name" TEXT,
    "bot_username" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "telegram_bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_bot_notification_settings" (
    "id" SERIAL NOT NULL,
    "telegram_bot_id" INTEGER NOT NULL,
    "allowed_hours" INTEGER[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_bot_notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_subscribers" (
    "id" SERIAL NOT NULL,
    "telegram_bot_id" INTEGER NOT NULL,
    "chat_id" TEXT NOT NULL,
    "name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_bot_notification_settings_telegram_bot_id_key" ON "telegram_bot_notification_settings"("telegram_bot_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_subscribers_telegram_bot_id_chat_id_key" ON "telegram_subscribers"("telegram_bot_id", "chat_id");

-- AddForeignKey
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_platform_account_id_fkey" FOREIGN KEY ("platform_account_id") REFERENCES "platform_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_bot_notification_settings" ADD CONSTRAINT "telegram_bot_notification_settings_telegram_bot_id_fkey" FOREIGN KEY ("telegram_bot_id") REFERENCES "telegram_bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_subscribers" ADD CONSTRAINT "telegram_subscribers_telegram_bot_id_fkey" FOREIGN KEY ("telegram_bot_id") REFERENCES "telegram_bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
