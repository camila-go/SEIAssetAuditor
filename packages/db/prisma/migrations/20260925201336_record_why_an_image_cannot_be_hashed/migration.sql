-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "phash_attempted_at" TIMESTAMP(3),
ADD COLUMN     "phash_skip_reason" TEXT;
