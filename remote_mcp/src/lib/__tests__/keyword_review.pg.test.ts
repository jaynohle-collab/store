import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "../db/client";
import { listKeywordReviewCandidates, upsertKeywordReviewCandidates, KeywordReviewUnavailableError } from "../db/keyword_review";
import { keywordReviewCandidateSchema, normalizeKeywordReviewUrl, upsertKeywordReviewCandidatesSchema } from "../discovery/keyword_review";

export const candidate = {
 candidate_key:"a".repeat(64), title:"Platform Engineer",company:"Example",source:"example-ats",
 url:"https://example.com/jobs?jobId=1&utm_source=news",location_text:"Remote",posted_date_text:"",
 bucket:"stronger" as const,keyword_score:70,score_components:{role_title:40,keyword_groups:30},
 matched_role_terms:["engineer"],matched_seniority_terms:[],matched_keyword_groups:[{group:"systems",aliases:["distributed"]}],
 listing_country_signal:"unknown",listing_work_mode_signal:"remote",eligibility_status:"unverified" as const,
 open_status:"unverified" as const,link_status:"unverified" as const,application_action:"none" as const,
 application_history:"not_checked" as const,duplicate_count:0,warnings:[],filter_reasons:[],
};
const payload = (profile: string, run=1, rows=[candidate]) => ({profile_id:profile,policy_version:"test-v1",policy_fingerprint:"b".repeat(64),run_id:`00000000-0000-4000-a000-${String(run).padStart(12,"0")}`,candidates:rows});
function adapter(db: PGlite): Sql {
 return (async (strings: TemplateStringsArray,...values: unknown[]) => {
  const query=strings.reduce((q,s,i)=>q+(i?`$${i}`:"")+s,"");
  return (await db.query(query, values)).rows;
 }) as unknown as Sql;
}
const db=new PGlite(); const sql=adapter(db);
beforeAll(async()=>{await db.exec(readFileSync("migrations/019_keyword_review.sql","utf8"));});
afterAll(async()=>{await db.close();});
describe("keyword review storage",()=>{
 it("accepts actual Python producer fixture and persists only review snapshots",async()=>{
  const fixture=JSON.parse(readFileSync("../job_agent/tests/fixtures/keyword_review_candidate_contract.json","utf8"));
  const parsed=upsertKeywordReviewCandidatesSchema.parse(fixture.request);
  expect(parsed.candidates).toHaveLength(fixture.request.candidates.length);
  const result=await upsertKeywordReviewCandidates(fixture.request,sql);
  expect(result.saved_count).toBe(fixture.request.candidates.length);
  const page=await listKeywordReviewCandidates({profileId:parsed.profile_id},sql);
  expect(page.candidates.length).toBe(parsed.candidates.filter(c=>c.bucket!=="filtered").length);
  expect(page.candidates.every(c=>c.label==="Keyword match, unverified" && c.application_action==="none")).toBe(true);
 });
 it("keeps exact retries idempotent, distinct runs seen before, first-seen immutable",async()=>{
  expect(await upsertKeywordReviewCandidates(payload("retry"),sql)).toMatchObject({new_count:1,saved_count:1});
  const first=(await listKeywordReviewCandidates({profileId:"retry"},sql)).candidates[0];
  expect(await upsertKeywordReviewCandidates(payload("retry"),sql)).toMatchObject({new_count:0,updated_count:0});
  expect((await listKeywordReviewCandidates({profileId:"retry"},sql)).candidates[0]).toMatchObject({seen_count:1,newness:"new_to_review",first_seen_at:first.first_seen_at});
  await upsertKeywordReviewCandidates(payload("retry",2),sql);
  const next=(await listKeywordReviewCandidates({profileId:"retry"},sql)).candidates[0];
  expect(next).toMatchObject({seen_count:2,newness:"seen_before",first_seen_at:first.first_seen_at});
  expect(next.last_seen_at>=first.last_seen_at).toBe(true);
  expect((await listKeywordReviewCandidates({profileId:"retry",newOnly:true},sql)).candidates).toHaveLength(0);
 });
 it("dedupes ATS identity across URL changes and merges transitive aliases",async()=>{
  const a={...candidate,url:"https://example.com/jobs/one",external_job_id:"ats-1"};
  const b={...candidate,url:"https://example.com/jobs/two",external_job_id:"ats-2"};
  await upsertKeywordReviewCandidates(payload("aliases",1,[a,b]),sql);
  expect((await listKeywordReviewCandidates({profileId:"aliases"},sql)).candidates).toHaveLength(2);
  await upsertKeywordReviewCandidates(payload("aliases",2,[{...a,url:b.url}]),sql);
  let rows=(await listKeywordReviewCandidates({profileId:"aliases"},sql)).candidates;
  expect(rows).toHaveLength(1); expect(rows[0].seen_count).toBe(2);
  await upsertKeywordReviewCandidates(payload("aliases",2,[b]),sql);
  rows=(await listKeywordReviewCandidates({profileId:"aliases"},sql)).candidates;
  expect(rows).toHaveLength(1);expect(rows[0].seen_count).toBe(2);
 });
 it("learns every supplied alias and reuses it when representative URLs change",async()=>{
  const a={...candidate,url:"https://example.com/alias-a",external_job_id:"one",identity_aliases:[{normalized_url:"https://example.com/alias-b?utm_source=x",source:candidate.source,company:candidate.company,external_job_id:"two"}]};
  await upsertKeywordReviewCandidates(payload("alias-history",1,[a]),sql);
  const first=(await listKeywordReviewCandidates({profileId:"alias-history"},sql)).candidates[0];
  const b={...candidate,url:"https://example.com/alias-b",external_job_id:"two"};
  expect(await upsertKeywordReviewCandidates(payload("alias-history",1,[b]),sql)).toMatchObject({new_count:0,saved_count:1});
  expect((await listKeywordReviewCandidates({profileId:"alias-history"},sql)).candidates[0]).toMatchObject({id:first.id,seen_count:1});
  await upsertKeywordReviewCandidates(payload("alias-history",2,[{...b,url:"https://example.com/alias-c"}]),sql);
  expect((await listKeywordReviewCandidates({profileId:"alias-history"},sql)).candidates).toHaveLength(1);
  expect((await listKeywordReviewCandidates({profileId:"alias-history"},sql)).candidates[0].seen_count).toBe(2);
  expect(keywordReviewCandidateSchema.safeParse({...a,identity_aliases:[{...a.identity_aliases[0],normalized_url:"http://localhost/private"}]}).success).toBe(false);
  expect(keywordReviewCandidateSchema.safeParse({...a,identity_aliases:Array(501).fill(a.identity_aliases[0])}).success).toBe(false);
 });
 it("isolates profiles and preserves query/fragment posting IDs",async()=>{
  const rows=[candidate,{...candidate,url:"https://example.com/jobs?jobId=2"},{...candidate,url:"https://example.com/jobs?jobId=2#third"}];
  await upsertKeywordReviewCandidates(payload("query",1,rows),sql);
  expect((await listKeywordReviewCandidates({profileId:"query"},sql)).candidates).toHaveLength(3);
  expect(await upsertKeywordReviewCandidates(payload("other"),sql)).toMatchObject({new_count:1});
 });
 it("paginates without overlap and searches/filter snapshots",async()=>{
  const one=await listKeywordReviewCandidates({profileId:"query",limit:2},sql);
  const two=await listKeywordReviewCandidates({profileId:"query",limit:2,offset:one.nextOffset!},sql);
  expect(one.nextOffset).toBe(2);expect(two.nextOffset).toBeNull();
  expect(new Set([...one.candidates,...two.candidates].map(c=>c.id)).size).toBe(3);
  expect((await listKeywordReviewCandidates({profileId:"query",q:"platform",bucket:"stronger"},sql)).candidates).toHaveLength(3);
  expect((await listKeywordReviewCandidates({profileId:"query",bucket:"filtered"},sql)).candidates).toHaveLength(0);
  expect((await listKeywordReviewCandidates({profileId:"query",freshSince:"2099-01-01T00:00:00Z"},sql)).candidates).toHaveLength(0);
 });
 it("excludes filtered by default but keeps explicit audit view",async()=>{
  await upsertKeywordReviewCandidates(payload("filter-default",1,[{...candidate,bucket:"filtered" as typeof candidate.bucket}]),sql);
  expect((await listKeywordReviewCandidates({profileId:"filter-default"},sql)).candidates).toHaveLength(0);
  expect((await listKeywordReviewCandidates({profileId:"filter-default",bucket:"filtered"},sql)).candidates).toHaveLength(1);
 });
 it("counts final distinct new rows when aliases merge within a batch",async()=>{
  const a={...candidate,url:"https://example.com/a",external_job_id:"a"};
  const b={...candidate,url:"https://example.com/b",external_job_id:"b"};
  expect(await upsertKeywordReviewCandidates(payload("batch-merge",1,[a,b,{...a,url:b.url}]),sql)).toMatchObject({saved_count:3,new_count:1,updated_count:0});
  expect((await listKeywordReviewCandidates({profileId:"batch-merge"},sql)).candidates).toHaveLength(1);
 });
 it("fails gracefully only for missing migration",async()=>{
  const missing=(async()=>{throw Object.assign(new Error('relation "keyword_review_candidates" does not exist'),{code:"42P01"});}) as unknown as Sql;
  expect(await listKeywordReviewCandidates({},missing)).toEqual({candidates:[],nextOffset:null,available:false});
  await expect(upsertKeywordReviewCandidates(payload("missing"),missing)).rejects.toBeInstanceOf(KeywordReviewUnavailableError);
  const broken=(async()=>{throw new Error("connection failed");}) as unknown as Sql;
  await expect(listKeywordReviewCandidates({},broken)).rejects.toThrow("connection failed");
 });
 it("rejects forged verification, application actions and unknown GPT claims",()=>{
  for(const patch of [{eligibility_status:"verified"},{open_status:"open"},{link_status:"verified"},{application_action:"apply"},{qualified:true}]) {
   expect(keywordReviewCandidateSchema.safeParse({...candidate,...patch}).success).toBe(false);
  }
  expect(keywordReviewCandidateSchema.safeParse({...candidate,url:"javascript:alert(1)"}).success).toBe(false);
  expect(normalizeKeywordReviewUrl(candidate.url)).toBe("https://example.com/jobs?jobId=1");
  for (const url of ["http://localhost/job", "http://2130706433/job", "http://127.0.0.1/job", "http://192.168.1.1/job", "http://[::1]/job", "http://machine/job", "https://company.local/job", "https://host.home.arpa/job", "https://example.com/", "https://example.com:8080/job", "https://example.com/jobs\\bad", "https://example.com/jobs\n"]) {
    expect(keywordReviewCandidateSchema.safeParse({...candidate,url}).success, url).toBe(false);
  }
 });
 it("bounds batches and validates all rows before any write",async()=>{
  expect(upsertKeywordReviewCandidatesSchema.safeParse(payload("bounds",1,Array(101).fill(candidate))).success).toBe(false);
  expect(upsertKeywordReviewCandidatesSchema.safeParse({...payload("bounds"),policy_fingerprint:"bad"}).success).toBe(false);
  await expect(upsertKeywordReviewCandidates(payload("atomic",1,[candidate,{...candidate,keyword_score:999}]),sql)).rejects.toThrow();
  expect((await listKeywordReviewCandidates({profileId:"atomic"},sql)).candidates).toHaveLength(0);
 });
 it("acknowledges duplicate input rows without double-counting observations",async()=>{
  expect(await upsertKeywordReviewCandidates(payload("duplicate-input",1,[candidate,candidate]),sql)).toMatchObject({saved_count:2,new_count:1,updated_count:0});
  expect((await listKeywordReviewCandidates({profileId:"duplicate-input"},sql)).candidates[0].seen_count).toBe(1);
 });
 it("ignores forged normalized URLs and has no canonical side effects",async()=>{
  await upsertKeywordReviewCandidates(payload("normalized",1,[{...candidate,normalized_url:"https://example.com/wrong"} as typeof candidate]),sql);
  expect((await listKeywordReviewCandidates({profileId:"normalized"},sql)).candidates[0].normalized_url).toBe("https://example.com/jobs?jobId=1");
  const tables=await db.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  expect(tables.rows.map(r=>r.tablename).sort()).toEqual(["keyword_review_aliases","keyword_review_candidates","keyword_review_observations"]);
 });
});
