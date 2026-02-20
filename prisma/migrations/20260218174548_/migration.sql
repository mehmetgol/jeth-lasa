/*
  Warnings:

  - Changed the type of `source` on the `Summary` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Made the column `title` on table `Summary` required. This step will fail if there are existing NULL values in that column.
  - Changed the type of `keywords` on the `Summary` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "SummarySource" AS ENUM ('pdf', 'image', 'pdf_image');

-- AlterTable
ALTER TABLE "Summary" DROP COLUMN "source",
ADD COLUMN     "source" "SummarySource" NOT NULL,
ALTER COLUMN "title" SET NOT NULL,
DROP COLUMN "keywords",
ADD COLUMN     "keywords" JSONB NOT NULL;

-- CreateIndex
CREATE INDEX "Summary_userId_id_idx" ON "Summary"("userId", "id");
