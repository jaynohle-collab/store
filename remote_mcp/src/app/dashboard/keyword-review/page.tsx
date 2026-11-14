import * as React from "react";
import { listKeywordReviewCandidates, type KeywordReviewRow } from "@/lib/db/keyword_review";
import { BUCKET_LABELS, PAGE_SIZE, parseReviewFilters, reviewDate, reviewPageHref, safeListingHref, humanizeReviewReason, reviewQuery } from "./view";

import CopyLinks from "./copy-links";

export const dynamic = "force-dynamic";
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const historyLabels = {
  matched: "Match in supplied application-history snapshot. Review before acting.",
  not_checked: "Application history not checked.",
  not_found_in_supplied_snapshot: "Not found in supplied snapshot. This does not confirm you have never applied.",
};

export default async function KeywordReviewPage({ searchParams }: Props) {
  let filters;
  try { filters = parseReviewFilters(await searchParams); }
  catch { return <div role="alert">Choose a valid collection date range. <a href="/dashboard/keyword-review">Reset filters</a></div>; }
  let candidates: KeywordReviewRow[] = [];
  let nextOffset: number | null = null;
  let unavailable = false;
  try {
    const page = await listKeywordReviewCandidates({ ...reviewQuery(filters), limit: PAGE_SIZE });
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
      <label htmlFor="review-from">First collected from (UTC)</label>
      <input id="review-from" name="from" type="date" defaultValue={filters.from} />
      <label htmlFor="review-to">Through (UTC, inclusive)</label>
      <input id="review-to" name="to" type="date" defaultValue={filters.to} />
      <button className="btn" type="submit">Filter</button>
      <a href="/dashboard/keyword-review">Reset filters</a>
    </form>
    <p className="muted">Dates filter when a job first entered this dashboard, not the employer posting date. Copy uses the applied filters across every page, not unsaved form edits.</p>
    {!unavailable && <CopyLinks key={reviewPageHref(filters, 0)} query={reviewPageHref(filters, 0).split("?")[1]} />}
    <p className="muted">Newest additions first · Up to {PAGE_SIZE} listings per page</p>
    {unavailable ? <div className="panel" role="status">Keyword review is not available yet, or could not be loaded. Review storage may not be configured yet. No application data has been changed. Try again after setup is complete.</div>
      : candidates.length === 0 ? <div className="panel" role="status">No matching jobs collected on this page. Try different filters, return to the first page, or run discovery.</div>
       : <div className="table-wrap"><table className="jobs" aria-label="Keyword match results"><thead><tr><th>Job / company</th><th>Location</th><th>Match</th><th>First collected</th><th>Posting date</th><th>Link / details</th></tr></thead><tbody>
        {candidates.map((candidate) => {
          const href = safeListingHref(candidate.url);
          return <tr key={candidate.id}>
            <td><strong>{candidate.title || "Untitled listing"}</strong><br />{candidate.company || "Company unknown"}<br /><small>{candidate.source}</small></td>
            <td>{candidate.location_text || "Not supplied"}</td>
            <td>{BUCKET_LABELS[candidate.bucket]}<br />Score: {candidate.keyword_score}<br /><small>{candidate.newness === "new_to_review" ? "New to review" : "Seen before"}</small></td>
            <td>{reviewDate(candidate.first_seen_at)}</td>
            <td>{candidate.posted_date_text || "Unknown; no date supplied"}</td>
            <td>{href ? <a href={href} target="_blank" rel="noopener noreferrer">Open listing ↗</a> : <span>No safe public HTTP(S) listing link supplied</span>}
              <details><summary>Match details</summary>
                <p>Matched roles: {candidate.matched_role_terms.join(", ") || "None recorded"}</p>
                <p>{candidate.matched_keyword_groups.map(group => `${group.group}: ${group.aliases.join(", ")}`).join("; ")}</p>
                <p>{historyLabels[candidate.application_history]}</p>
                <p>Last collected: {reviewDate(candidate.last_seen_at)} · Sightings: {candidate.seen_count}</p>
                <p>Eligibility, availability and links are unverified.</p>
                {[...candidate.warnings, ...candidate.filter_reasons].map((reason, i) => <p key={i}>{humanizeReviewReason(reason)}</p>)}
              </details>
            </td>
          </tr>;
        })}
      </tbody></table></div>}
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
