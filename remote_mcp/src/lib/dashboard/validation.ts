import { z } from "zod";

import { APPLICATION_STATUS_TRANSITIONS } from "./constants";

export const uuidSchema = z.string().uuid();

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const sortSchema = z.enum(["newest", "posted", "match", "company"]).default("newest");

export const lifecycleSchema = z.enum(["new", "repost", "all"]).optional();

export const jobsQuerySchema = z.object({
  q: z.string().max(512).optional(),
  date_from: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
  date_to: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
  min_match: z.coerce.number().finite().optional(),
  application_status: z.string().max(64).optional(),
  lifecycle: lifecycleSchema,
  remote_status: z.string().max(128).optional(),
  company: z.string().max(512).optional(),
  source: z.string().max(256).optional(),
  to_apply: z.enum(["0", "1"]).optional(),
  applied: z.enum(["0", "1"]).optional(),
  interviewing: z.enum(["0", "1"]).optional(),
  reposted: z.enum(["0", "1"]).optional(),
  sort: sortSchema,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const summaryQuerySchema = z.object({
  threshold: z.coerce.number().finite().optional(),
});

export const markAppliedBodySchema = z.object({
  posting_id: uuidSchema,
  application_url: z.string().url().max(2048).optional(),
  resume_version: z.string().max(256).optional(),
  notes: z.string().max(20_000).optional(),
  applied_at: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
});

export const updateApplicationBodySchema = z.object({
  status: z.enum(APPLICATION_STATUS_TRANSITIONS as unknown as [string, ...string[]]),
  notes: z.string().max(20_000).optional(),
});

export const jobPatchBodySchema = z.object({
  action: z.literal("ignore"),
});
