-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "embedded_at" TIMESTAMP(3),
ADD COLUMN     "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
ADD COLUMN     "embedding_model" TEXT;

-- AlterTable
ALTER TABLE "testimonials" ADD COLUMN     "embedded_at" TIMESTAMP(3),
ADD COLUMN     "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
ADD COLUMN     "embedding_model" TEXT;
