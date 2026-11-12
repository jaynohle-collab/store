import * as React from "react";
import { listKeywordReviewCandidates, type KeywordReviewRow } from "@/lib/db/keyword_review";
import { BUCKET_LABELS, PAGE_SIZE, parseReviewFilters, reviewDate, reviewPageHref, safeListingHref, humanizeReviewReason } from "./view";

export const dynamic = "force-dynamic";
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const historyLabels = {
  matched: "Match in supplied application-history snapshot. Review before acting.",
  not_checked: "Application history not checked.",
  not_found_in_supplied_snapshot: "Not found in supplied snapshot. This does not confirm you have never applied.",
};

export default async function KeywordReviewPage({ searchParams }: Props) {
  const filters = parseReviewFilters(await searchParams);
  let candidates: KeywordReviewRow[] = [];
  let nextOffset: number | null = null;
  let unavailable = false;
  try {
    const page = await listKeywordReviewCandidates({ ...filters, limit: PAGE_SIZE });
    candidates = page.candidates;
    nextOffset = page.nextOffset;
    unavailable = !page.available;
  } catch { unavailable = true; }
  return <>
    <div className="dash-header"><div><h1>Keyword matches</h1><p>Browse keyword matches and choose what deserves a closer look. No AI review is required.</p></div></div>
    <div className="panel" style={{ marginBottom: "1rem" }}>
      <strong>Keyword match, unverified</strong>
      <p>Keyword scores describe text matches, not suitability or eligibility. Availability, eligibility, and link authenticity have not been checked. Location, country, and work mode are listing claims, not confirmed facts.</p>
      <p>“New to review” means seen in only one collection run, not newly posted by the employer. Employer posting dates are shown separately and may be unknown. Opening this page does not mark jobs as seen.</p>
      <p>This read-only page does not submit applications or change application status.</p>
    </div>
    <form method="get" action="/dashboard/keyword-review" className="toolbar">
      <label htmlFor="review-search">Search listings</label>
      <input id="review-search" name="q" type="search" defaultValue={filters.q} placeholder="Title, company, or location" maxLength={200} />
      <label htmlFor="review-bucket">Match group</label>
      <select id="review-bucket" name="bucket" defaultValue={filters.bucket ?? ""}>
        <option value="">All matching groups</option>
        {Object.entries(BUCKET_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <label><input type="checkbox" name="new" value="1" defaultChecked={filters.newOnly} /> New to review only</label>
      <button className="btn" type="submit">Filter</button>
      <a href="/dashboard/keyword-review">Reset filters</a>
    </form>
    <p className="muted">Newest additions first · Up to {PAGE_SIZE} listings per page</p>
    {unavailable ? <div className="panel" role="status">Keyword review is not available yet, or could not be loaded. Review storage may not be configured yet. No application data has been changed. Try again after setup is complete.</div>
      : candidates.length === 0 ? <div className="panel" role="status">No matching jobs collected on this page. Try different filters, return to the first page, or run discovery.</div>
      : <div aria-label="Keyword match results" style={{ display: "grid", gap: "1rem" }}>
        {candidates.map((candidate) => {
          const href = safeListingHref(candidate.url);
          return <article key={candidate.id} className="panel" style={{ overflowWrap: "anywhere" }}>
            <h2>{candidate.title || "Untitled listing"}</h2>
            <p><strong>{candidate.company || "Company unknown"}</strong> · Source: {candidate.source || "Unknown"}</p>
            <p><strong>{candidate.newness === "new_to_review" ? "New to review" : "Seen in an earlier scan"}</strong> · {BUCKET_LABELS[candidate.bucket]} · Keyword score: {candidate.keyword_score}</p>
            <p>Location as listed: {candidate.location_text || "Not supplied"}</p>
            <p>Country signal in listing: {candidate.listing_country_signal || "Not supplied"} · Work mode signal in listing: {candidate.listing_work_mode_signal || "Not supplied"}</p>
            <p>Employer posting date (as supplied): {candidate.posted_date_text || "Unknown; no date supplied"}</p>
            <p className="muted">First added to review: {reviewDate(candidate.first_seen_at)} · Last collected: {reviewDate(candidate.last_seen_at)} · Collection sightings: {candidate.seen_count}</p>
            <p><strong>Matched role terms:</strong> {candidate.matched_role_terms.join(", ") || "None recorded"}</p>
            <div><strong>Matched keyword groups:</strong>{candidate.matched_keyword_groups.length ? <ul>{candidate.matched_keyword_groups.map((group, i) => <li key={i}>{group.group}: {group.aliases.join(", ") || "No terms recorded"}</li>)}</ul> : " None recorded"}</div>
            <p>Eligibility: unverified · Open status: unverified · Link: unverified</p>
            <p>{historyLabels[candidate.application_history]}</p>
            {candidate.warnings.length ? <div><strong>Warnings</strong><ul>{candidate.warnings.map((warning, i) => <li key={i}>{humanizeReviewReason(warning)}</li>)}</ul></div> : null}
            {candidate.filter_reasons.length ? <div><strong>Filter reasons</strong><ul>{candidate.filter_reasons.map((reason, i) => <li key={i}>{humanizeReviewReason(reason)}</li>)}</ul></div> : null}
            <p className="muted">Keyword policy: {candidate.policy_version}</p>
            {href ? <p><a href={href} target="_blank" rel="noopener noreferrer">Open supplied listing ↗</a><br /><small>{href}</small><br /><small>External site. Employer/ATS authenticity and redirects have not been checked.</small></p> : <p className="muted">No safe public HTTP(S) listing link supplied.</p>}
          </article>;
        })}
      </div>}
    {!unavailable && <nav aria-label="Keyword review pagination" className="pagination-bar">
      <span className="pagination-meta">{candidates.length ? `Showing ${filters.offset + 1}–${filters.offset + candidates.length}` : "No listings shown"}</span>
      <div className="pagination-controls">
        {filters.offset > 0 ? <a href={reviewPageHref(filters, Math.max(0, filters.offset - PAGE_SIZE))}>← Previous page</a> : null}
        {filters.offset > PAGE_SIZE ? <a href={reviewPageHref(filters, 0)}>First page</a> : null}
        {nextOffset !== null ? <a href={reviewPageHref(filters, nextOffset)}>Next page →</a> : null}
      </div>
    </nav>}
  </>;
}
