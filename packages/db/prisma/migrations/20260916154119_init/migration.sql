-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('image', 'video', 'document', 'audio', 'other');

-- CreateEnum
CREATE TYPE "AuditJobStatus" AS ENUM ('queued', 'running', 'complete', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "AuditInputType" AS ENUM ('paste', 'csv_upload', 'sitemap');

-- CreateEnum
CREATE TYPE "AuditUrlStatus" AS ENUM ('pending', 'done', 'failed');

-- CreateEnum
CREATE TYPE "TestimonialSourceType" AS ENUM ('structured_component', 'hardcoded_text');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('draft', 'pending_review', 'legal_approved', 'marketing_approved', 'approved', 'rejected', 'resubmitted');

-- CreateEnum
CREATE TYPE "ApproverType" AS ENUM ('legal', 'marketing');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('approved', 'rejected');

-- CreateEnum
CREATE TYPE "TranscriptStatus" AS ENUM ('pending', 'processing', 'complete', 'failed');

-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('meta', 'tiktok', 'youtube', 'linkedin');

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "aem_path" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "asset_type" "AssetType" NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "file_size" INTEGER,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_seen_at" TIMESTAMP(3),
    "phash" TEXT,
    "is_indexed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "is_published" BOOLEAN,
    "last_replicated_at" TIMESTAMP(3),
    "last_crawled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_page_references" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "discovered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_page_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_jobs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AuditJobStatus" NOT NULL DEFAULT 'queued',
    "input_type" "AuditInputType" NOT NULL,
    "total_urls" INTEGER NOT NULL DEFAULT 0,
    "completed_urls" INTEGER NOT NULL DEFAULT 0,
    "failed_urls" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_by" TEXT,
    "error_message" TEXT,

    CONSTRAINT "audit_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_job_urls" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "AuditUrlStatus" NOT NULL DEFAULT 'pending',
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "asset_count" INTEGER NOT NULL DEFAULT 0,
    "testimonial_count" INTEGER NOT NULL DEFAULT 0,
    "page_title" TEXT,
    "is_published" BOOLEAN,

    CONSTRAINT "audit_job_urls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testimonials" (
    "id" TEXT NOT NULL,
    "quote_text" TEXT NOT NULL,
    "quote_fingerprint" TEXT NOT NULL,
    "student_name" TEXT,
    "program" TEXT,
    "degree_level" TEXT,
    "source_type" "TestimonialSourceType" NOT NULL,
    "raw_html" TEXT,
    "aem_component_path" TEXT,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "testimonials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testimonial_page_references" (
    "id" TEXT NOT NULL,
    "testimonial_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "position_on_page" INTEGER,
    "discovered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "testimonial_page_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_submissions" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "campaign" TEXT NOT NULL,
    "usage_rights" TEXT NOT NULL,
    "rights_expiry_date" TIMESTAMP(3) NOT NULL,
    "submitter_name" TEXT NOT NULL,
    "submitter_email" TEXT NOT NULL,
    "submitter_org" TEXT NOT NULL,
    "notes" TEXT,
    "filename" TEXT NOT NULL,
    "file_size" INTEGER,
    "mime_type" TEXT NOT NULL,
    "legal_agreed" BOOLEAN NOT NULL DEFAULT true,
    "legal_agreed_at" TIMESTAMP(3) NOT NULL,
    "legal_agreed_ip" TEXT,
    "legal_doc_filename" TEXT,
    "legal_doc_stored_path" TEXT,
    "transcript" TEXT,
    "transcript_status" "TranscriptStatus" NOT NULL DEFAULT 'pending',
    "transcript_duration_seconds" INTEGER,
    "chapter_markers" JSONB,
    "vtt_aem_path" TEXT,
    "aem_staging_path" TEXT,
    "aem_final_path" TEXT,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'draft',
    "rejection_reason" TEXT,
    "parent_submission_id" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_approvals" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "approver_type" "ApproverType" NOT NULL,
    "approver_email" TEXT NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "reason" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_links" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "post_url" TEXT NOT NULL,
    "post_id" TEXT,
    "metrics_json" JSONB,
    "last_fetched_at" TIMESTAMP(3),

    CONSTRAINT "social_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assets_aem_path_key" ON "assets"("aem_path");

-- CreateIndex
CREATE INDEX "assets_phash_idx" ON "assets"("phash");

-- CreateIndex
CREATE INDEX "assets_filename_idx" ON "assets"("filename");

-- CreateIndex
CREATE INDEX "assets_asset_type_deleted_at_idx" ON "assets"("asset_type", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "pages_url_key" ON "pages"("url");

-- CreateIndex
CREATE INDEX "pages_is_published_deleted_at_idx" ON "pages"("is_published", "deleted_at");

-- CreateIndex
CREATE INDEX "pages_last_crawled_at_idx" ON "pages"("last_crawled_at");

-- CreateIndex
CREATE INDEX "asset_page_references_page_id_idx" ON "asset_page_references"("page_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_page_references_asset_id_page_id_key" ON "asset_page_references"("asset_id", "page_id");

-- CreateIndex
CREATE INDEX "audit_jobs_status_idx" ON "audit_jobs"("status");

-- CreateIndex
CREATE INDEX "audit_jobs_created_at_idx" ON "audit_jobs"("created_at");

-- CreateIndex
CREATE INDEX "audit_job_urls_job_id_status_idx" ON "audit_job_urls"("job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "audit_job_urls_job_id_url_key" ON "audit_job_urls"("job_id", "url");

-- CreateIndex
CREATE UNIQUE INDEX "testimonials_quote_fingerprint_key" ON "testimonials"("quote_fingerprint");

-- CreateIndex
CREATE INDEX "testimonials_program_idx" ON "testimonials"("program");

-- CreateIndex
CREATE INDEX "testimonials_student_name_idx" ON "testimonials"("student_name");

-- CreateIndex
CREATE INDEX "testimonials_needs_review_idx" ON "testimonials"("needs_review");

-- CreateIndex
CREATE INDEX "testimonials_last_seen_at_idx" ON "testimonials"("last_seen_at");

-- CreateIndex
CREATE INDEX "testimonial_page_references_page_id_idx" ON "testimonial_page_references"("page_id");

-- CreateIndex
CREATE UNIQUE INDEX "testimonial_page_references_testimonial_id_page_id_key" ON "testimonial_page_references"("testimonial_id", "page_id");

-- CreateIndex
CREATE INDEX "video_submissions_status_idx" ON "video_submissions"("status");

-- CreateIndex
CREATE INDEX "video_submissions_submitter_email_idx" ON "video_submissions"("submitter_email");

-- CreateIndex
CREATE INDEX "video_submissions_program_idx" ON "video_submissions"("program");

-- CreateIndex
CREATE INDEX "video_submissions_submitted_at_idx" ON "video_submissions"("submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "video_approvals_submission_id_approver_type_key" ON "video_approvals"("submission_id", "approver_type");

-- CreateIndex
CREATE INDEX "social_links_asset_id_idx" ON "social_links"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_links_platform_post_url_key" ON "social_links"("platform", "post_url");

-- AddForeignKey
ALTER TABLE "asset_page_references" ADD CONSTRAINT "asset_page_references_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_page_references" ADD CONSTRAINT "asset_page_references_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_job_urls" ADD CONSTRAINT "audit_job_urls_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "audit_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testimonial_page_references" ADD CONSTRAINT "testimonial_page_references_testimonial_id_fkey" FOREIGN KEY ("testimonial_id") REFERENCES "testimonials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "testimonial_page_references" ADD CONSTRAINT "testimonial_page_references_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_submissions" ADD CONSTRAINT "video_submissions_parent_submission_id_fkey" FOREIGN KEY ("parent_submission_id") REFERENCES "video_submissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_approvals" ADD CONSTRAINT "video_approvals_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "video_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_links" ADD CONSTRAINT "social_links_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
