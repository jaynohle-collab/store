import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({sql:vi.fn(),getSql:vi.fn(),session:vi.fn()}));
vi.mock("@/lib/db/client",()=>({getSql:()=>mocks.getSql()}));
vi.mock("@/lib/auth0",()=>({auth0:{getSession:()=>mocks.session()}}));
import { registerKeywordReviewTools } from "../mcp/keyword_review_tools";
import { requiredPermissionForTool } from "../auth/permissions";
import { isDashboardProtectedPath } from "../dashboard/auth";
import * as route from "@/app/api/keyword-review/route";
const handlers: Record<string,(args:unknown,extra:unknown)=>Promise<{isError?:boolean}>>={};
registerKeywordReviewTools({registerTool:(name:string,_config:unknown,handler:typeof handlers[string])=>{handlers[name]=handler;}} as unknown as McpServer);
const validRequest=JSON.parse(readFileSync("../job_agent/tests/fixtures/keyword_review_candidate_contract.json","utf8")).request;
const writer={http:{authInfo:{scopes:["jobs:write"]}}};
beforeEach(()=>{
 mocks.sql.mockReset().mockResolvedValue([]);
 mocks.getSql.mockReset().mockReturnValue(mocks.sql);
 mocks.session.mockReset();
 vi.stubEnv("DASHBOARD_ALLOWED_EMAILS","owner@example.com");
 vi.stubEnv("KEYWORD_REVIEW_ACTIVATION_APPROVED",undefined);
});
afterEach(()=>vi.unstubAllEnvs());
describe("keyword review authorization",()=>{
 it("requires jobs:write before any DB action",async()=>{
  vi.stubEnv("KEYWORD_REVIEW_ACTIVATION_APPROVED","true");
  expect(requiredPermissionForTool("upsert_keyword_review_candidates")).toBe("jobs:write");
  for(const extra of [{},{http:{authInfo:{scopes:["jobs:read"]}}},{http:{authInfo:{scopes:["jobs:worker"]}}}]) {
   expect(await handlers.upsert_keyword_review_candidates({},extra)).toMatchObject({isError:true,content:[{type:"text",text:"Missing required permission: jobs:write"}]});
  }
  expect(mocks.sql).not.toHaveBeenCalled();
 });
 it("blocks every non-exact activation value before constructing the DB client",async()=>{
  for(const value of [undefined,"false","1","yes","TRUE",""," "," true","true ","true\n"]) {
   vi.stubEnv("KEYWORD_REVIEW_ACTIVATION_APPROVED",value);
   expect(await handlers.upsert_keyword_review_candidates(validRequest,writer)).toMatchObject({isError:true,content:[{type:"text",text:"Keyword review writes are disabled until activation is explicitly approved."}]});
  }
  expect(mocks.getSql).not.toHaveBeenCalled();
  expect(mocks.sql).not.toHaveBeenCalled();
 });
 it("allows a valid payload only with exact true activation",async()=>{
  vi.stubEnv("KEYWORD_REVIEW_ACTIVATION_APPROVED","true");
  mocks.sql.mockResolvedValue([{result:{saved_count:validRequest.candidates.length,new_count:validRequest.candidates.length,updated_count:0}}]);
  expect(await handlers.upsert_keyword_review_candidates(validRequest,writer)).toMatchObject({structuredContent:{ok:true,saved_count:validRequest.candidates.length,run_id:validRequest.run_id}});
  expect(mocks.getSql).toHaveBeenCalledOnce();
  expect(mocks.sql).toHaveBeenCalledOnce();
  expect(mocks.sql.mock.calls[0][1]).toBe(validRequest.profile_id);
 });
 it("validates authorized payload before DB access",async()=>{
  vi.stubEnv("KEYWORD_REVIEW_ACTIVATION_APPROVED","true");
  expect(await handlers.upsert_keyword_review_candidates({candidates:[]},{http:{authInfo:{scopes:["jobs:write"]}}})).toMatchObject({isError:true});
  expect(mocks.sql).not.toHaveBeenCalled();
 });
 it("API is GET only, middleware protected, unauthenticated reads rejected",async()=>{
  expect(Object.keys(route).sort()).toEqual(["GET","dynamic"]);
  expect(isDashboardProtectedPath("/api/keyword-review")).toBe(true);
  mocks.session.mockResolvedValue(null);
  expect((await route.GET(new Request("http://localhost/api/keyword-review"))).status).toBe(401);
  expect(mocks.sql).not.toHaveBeenCalled();
 });
 it("denies unverified and nonallowlisted sessions",async()=>{
  for(const user of [{email:"owner@example.com",email_verified:false},{email:"other@example.com",email_verified:true}]){
   mocks.session.mockResolvedValue({user});
   expect((await route.GET(new Request("http://localhost/api/keyword-review"))).status).toBe(403);
  }
  expect(mocks.sql).not.toHaveBeenCalled();
 });
 it("validates filters and serves only authenticated no-store responses",async()=>{
  mocks.session.mockResolvedValue({user:{email:"owner@example.com",email_verified:true}});
  expect((await route.GET(new Request("http://localhost/api/keyword-review?limit=1000"))).status).toBe(400);
  expect(mocks.sql).not.toHaveBeenCalled();
  const response=await route.GET(new Request("http://localhost/api/keyword-review?newOnly=false"));
  expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ok:true,available:true,candidates:[],nextOffset:null});
 });
});
