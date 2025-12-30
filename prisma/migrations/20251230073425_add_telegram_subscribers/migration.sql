-- CreateTable
CREATE TABLE "telegram_subscribers" (
    "id" SERIAL NOT NULL,
    "chat_id" TEXT NOT NULL,
    "name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_subscribers_chat_id_key" ON "telegram_subscribers"("chat_id");
