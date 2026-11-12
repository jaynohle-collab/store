import type { McpServer } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({sql:vi.fn(),session:vi.fn()}));
vi.mock("@/lib/db/client",()=>({getSql:()=>mocks.sql}));
vi.mock("@/lib/auth0",()=>({auth0:{getSession:()=>mocks.session()}}));
import { registerKeywordReviewTools } from "../mcp/keyword_review_tools";
import { requiredPermissionForTool } from "../auth/permissions";
import { isDashboardProtectedPath } from "../dashboard/auth";
import * as route from "@/app/api/keyword-review/route";
const handlers: Record<string,(args:unknown,extra:unknown)=>Promise<{isError?:boolean}>>={};
registerKeywordReviewTools({registerTool:(name:string,_config:unknown,handler:typeof handlers[string])=>{handlers[name]=handler;}} as unknown as McpServer);
beforeEach(()=>{mocks.sql.mockReset().mockResolvedValue([]);mocks.session.mockReset();process.env.DASHBOARD_ALLOWED_EMAILS="owner@example.com";});
describe("keyword review authorization",()=>{
 it("requires jobs:write before any DB action",async()=>{
  expect(requiredPermissionForTool("upsert_keyword_review_candidates")).toBe("jobs:write");
  for(const extra of [{},{http:{authInfo:{scopes:["jobs:read"]}}},{http:{authInfo:{scopes:["jobs:worker"]}}}]) {
   expect(await handlers.upsert_keyword_review_candidates({},extra)).toMatchObject({isError:true});
  }
  expect(mocks.sql).not.toHaveBeenCalled();
 });
 it("validates authorized payload before DB access",async()=>{
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
