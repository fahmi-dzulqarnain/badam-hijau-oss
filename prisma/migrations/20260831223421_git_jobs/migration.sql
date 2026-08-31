-- CreateEnum
CREATE TYPE "GitJobState" AS ENUM ('PENDING', 'RUNNING', 'FAILED', 'DONE');

-- CreateEnum
CREATE TYPE "GitJobKind" AS ENUM ('PUBLISH', 'MOVE', 'DELETE', 'RESTORE');

-- CreateTable
CREATE TABLE "GitJob" (
    "id" SERIAL NOT NULL,
    "kind" "GitJobKind" NOT NULL,
    "state" "GitJobState" NOT NULL DEFAULT 'PENDING',
    "pageId" TEXT NOT NULL,
    "versionId" TEXT,
    "spaceKey" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "fromPath" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GitJob_state_nextAttemptAt_id_idx" ON "GitJob"("state", "nextAttemptAt", "id");

-- CreateIndex
CREATE INDEX "GitJob_pageId_id_idx" ON "GitJob"("pageId", "id");

-- AddForeignKey
ALTER TABLE "GitJob" ADD CONSTRAINT "GitJob_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitJob" ADD CONSTRAINT "GitJob_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "PageVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
