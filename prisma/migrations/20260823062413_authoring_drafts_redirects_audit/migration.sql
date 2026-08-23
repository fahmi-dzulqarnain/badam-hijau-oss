-- AlterTable
ALTER TABLE "Page" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PageDraft" (
    "pageId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "frontmatter" JSONB NOT NULL DEFAULT '{}',
    "baseVersionId" TEXT,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageDraft_pkey" PRIMARY KEY ("pageId")
);

-- CreateTable
CREATE TABLE "Redirect" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toPageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Redirect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "spaceId" TEXT,
    "pageId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Redirect_toPageId_idx" ON "Redirect"("toPageId");

-- CreateIndex
CREATE UNIQUE INDEX "Redirect_spaceId_fromPath_key" ON "Redirect"("spaceId", "fromPath");

-- CreateIndex
CREATE INDEX "AuditLog_spaceId_createdAt_idx" ON "AuditLog"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_pageId_createdAt_idx" ON "AuditLog"("pageId", "createdAt");

-- CreateIndex
CREATE INDEX "Page_spaceId_deletedAt_idx" ON "Page"("spaceId", "deletedAt");

-- AddForeignKey
ALTER TABLE "PageDraft" ADD CONSTRAINT "PageDraft_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageDraft" ADD CONSTRAINT "PageDraft_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "PageVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageDraft" ADD CONSTRAINT "PageDraft_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redirect" ADD CONSTRAINT "Redirect_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redirect" ADD CONSTRAINT "Redirect_toPageId_fkey" FOREIGN KEY ("toPageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
