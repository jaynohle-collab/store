import { z } from "zod";

import { getSql } from "./client";

const skillsSchema = z.array(z.string()).default([]);
export const postedDateSchema = z.union([
  z.iso.date(),
  z.iso.datetime({ offset: true }),
]);

export const saveJobInputSchema = z.object({
  company: z.string().min(1).max(512),
  title: z.string().min(1).max(512),
  url: z.string().url().max(2048),
  location: z.string().max(512).optional(),
  source: z.string().max(256).optional(),
  description: z.string().max(100_000).optional(),
  description_hash: z.string().min(1).max(128).optional(),
  required_skills: skillsSchema.optional(),
  preferred_skills: skillsSchema.optional(),
  remote_status: z.string().max(128).optional(),
  salary: z.string().max(256).optional(),
  posted_date: postedDateSchema.optional(),
});

export type SaveJobInput = z.infer<typeof saveJobInputSchema>;

export type JobRecord = {
  id: string;
  company: string;
  title: string;
  url: string;
  location: string | null;
  source: string | null;
  description: string | null;
  description_hash: string | null;
  required_skills: unknown;
  preferred_skills: unknown;
  remote_status: string | null;
  salary: string | null;
  posted_date: string | null;
  created_at: string;
  updated_at: string;
};

function mapRow(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    company: String(row.company),
    title: String(row.title),
    url: String(row.url),
    location: row.location == null ? null : String(row.location),
    source: row.source == null ? null : String(row.source),
    description: row.description == null ? null : String(row.description),
    description_hash: row.description_hash == null ? null : String(row.description_hash),
    required_skills: row.required_skills ?? [],
    preferred_skills: row.preferred_skills ?? [],
    remote_status: row.remote_status == null ? null : String(row.remote_status),
    salary: row.salary == null ? null : String(row.salary),
    posted_date: row.posted_date == null ? null : String(row.posted_date),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function saveJob(input: SaveJobInput): Promise<JobRecord> {
  const sql = getSql();
  const requiredSkills = JSON.stringify(input.required_skills ?? []);
  const preferredSkills = JSON.stringify(input.preferred_skills ?? []);
  const postedDate = input.posted_date ? new Date(input.posted_date) : null;

  const rows = await sql`
    INSERT INTO jobs (
      company, title, url, location, source, description, description_hash,
      required_skills, preferred_skills, remote_status, salary, posted_date
    ) VALUES (
      ${input.company},
      ${input.title},
      ${input.url},
      ${input.location ?? null},
      ${input.source ?? null},
      ${input.description ?? null},
      ${input.description_hash ?? null},
      ${requiredSkills}::jsonb,
      ${preferredSkills}::jsonb,
      ${input.remote_status ?? null},
      ${input.salary ?? null},
      ${postedDate}
    )
    RETURNING *
  `;

  return mapRow(rows[0] as Record<string, unknown>);
}

export async function getJob(id: string): Promise<JobRecord | null> {
  const sql = getSql();
  const rows = await sql`SELECT * FROM jobs WHERE id = ${id}::uuid LIMIT 1`;
  if (!rows.length) return null;
  return mapRow(rows[0] as Record<string, unknown>);
}

export type JobPage = {
  jobs: JobRecord[];
  nextOffset: number | null;
};

export async function searchJobs(
  query: string,
  limit: number,
  offset = 0,
): Promise<JobPage> {
  const sql = getSql();
  const pattern = `%${query}%`;
  const fetchLimit = limit + 1;
  const rows = await sql`
    SELECT * FROM jobs
    WHERE
      company ILIKE ${pattern}
      OR title ILIKE ${pattern}
      OR url ILIKE ${pattern}
      OR COALESCE(location, '') ILIKE ${pattern}
      OR COALESCE(source, '') ILIKE ${pattern}
      OR COALESCE(description, '') ILIKE ${pattern}
    ORDER BY created_at DESC
    LIMIT ${fetchLimit}
    OFFSET ${offset}
  `;
  const hasMore = rows.length > limit;
  const jobs = rows
    .slice(0, limit)
    .map((row) => mapRow(row as Record<string, unknown>));
  return {
    jobs,
    nextOffset: hasMore ? offset + jobs.length : null,
  };
}

export async function listRecentJobs(
  days: number,
  limit: number,
  offset = 0,
): Promise<JobPage> {
  const sql = getSql();
  const fetchLimit = limit + 1;
  const rows = await sql`
    SELECT * FROM jobs
    WHERE created_at >= NOW() - (${days}::text || ' days')::interval
    ORDER BY created_at DESC
    LIMIT ${fetchLimit}
    OFFSET ${offset}
  `;
  const hasMore = rows.length > limit;
  const jobs = rows
    .slice(0, limit)
    .map((row) => mapRow(row as Record<string, unknown>));
  return {
    jobs,
    nextOffset: hasMore ? offset + jobs.length : null,
  };
}

export async function deleteJob(id: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    DELETE FROM jobs WHERE id = ${id}::uuid RETURNING id
  `;
  return rows.length > 0;
}
