-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "auto_match_keywords" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avatar_url" TEXT,
ADD COLUMN     "gemini_api_key" TEXT;
