-- AlterTable
ALTER TABLE "telegram_subscribers" ADD COLUMN     "receive_notifications" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "user_cron_settings" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "cron_type" TEXT NOT NULL,
    "allowed_hours" INTEGER[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_cron_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_ad_accounts" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_ad_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_cron_settings_user_id_idx" ON "user_cron_settings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_cron_settings_user_id_cron_type_key" ON "user_cron_settings"("user_id", "cron_type");

-- CreateIndex
CREATE INDEX "user_ad_accounts_user_id_idx" ON "user_ad_accounts"("user_id");

-- CreateIndex
CREATE INDEX "user_ad_accounts_ad_account_id_idx" ON "user_ad_accounts"("ad_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_ad_accounts_user_id_ad_account_id_key" ON "user_ad_accounts"("user_id", "ad_account_id");

-- AddForeignKey
ALTER TABLE "user_cron_settings" ADD CONSTRAINT "user_cron_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_ad_accounts" ADD CONSTRAINT "user_ad_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_ad_accounts" ADD CONSTRAINT "user_ad_accounts_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
