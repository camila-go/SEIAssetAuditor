-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "last_verified_at" TIMESTAMP(3),
ADD COLUMN     "last_verified_status" INTEGER;

-- CreateIndex
CREATE INDEX "assets_last_verified_at_idx" ON "assets"("last_verified_at");
