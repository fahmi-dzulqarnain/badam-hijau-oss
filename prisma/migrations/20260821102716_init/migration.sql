-- CreateEnum
CREATE TYPE "SpaceVisibility" AS ENUM ('MEMBERS', 'ALL_STAFF');

-- CreateEnum
CREATE TYPE "SpaceRole" AS ENUM ('VIEWER', 'EDITOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "BugStatus" AS ENUM ('NEW', 'TRIAGED', 'CLOSED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Space" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "initials" TEXT NOT NULL,
    "visibility" "SpaceVisibility" NOT NULL DEFAULT 'MEMBERS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Space_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpaceMembership" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "SpaceRole" NOT NULL DEFAULT 'VIEWER',

    CONSTRAINT "SpaceMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BugReport" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "expected" TEXT,
    "routePath" TEXT NOT NULL,
    "spaceId" TEXT,
    "pageId" TEXT,
    "versionId" TEXT,
    "appVersion" TEXT NOT NULL,
    "gitSha" TEXT,
    "userAgent" TEXT NOT NULL,
    "viewport" TEXT NOT NULL,
    "consoleError" TEXT,
    "status" "BugStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BugReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Space_key_key" ON "Space"("key");

-- CreateIndex
CREATE INDEX "SpaceMembership_userId_idx" ON "SpaceMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SpaceMembership_spaceId_userId_key" ON "SpaceMembership"("spaceId", "userId");

-- CreateIndex
CREATE INDEX "BugReport_status_createdAt_idx" ON "BugReport"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "SpaceMembership" ADD CONSTRAINT "SpaceMembership_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpaceMembership" ADD CONSTRAINT "SpaceMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BugReport" ADD CONSTRAINT "BugReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
