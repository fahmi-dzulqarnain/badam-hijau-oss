-- CreateEnum
CREATE TYPE "RelationType" AS ENUM ('SUPERSEDES', 'DECIDES', 'AMENDS', 'RELATES_TO');

-- CreateTable
CREATE TABLE "PageRelation" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "type" "RelationType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageRelation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PageRelation_toId_type_idx" ON "PageRelation"("toId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "PageRelation_fromId_toId_type_key" ON "PageRelation"("fromId", "toId", "type");

-- AddForeignKey
ALTER TABLE "PageRelation" ADD CONSTRAINT "PageRelation_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageRelation" ADD CONSTRAINT "PageRelation_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;
