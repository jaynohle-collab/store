import Link from "next/link";

import { formatMatch } from "@/lib/dashboard/display";

import { MarkAppliedButton, IgnoreButton } from "./Actions";

export { formatMatch } from "@/lib/dashboard/display";

export function Badge({ kind, children }: { kind: string; children: React.ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function JobBadges(job: Record<string, unknown>) {
  const status = String(job.application_status || "").toLowerCase();
  const postingStatus = String(job.posting_status || "").toLowerCase();
  return (
    <span>
      {job.is_repost ? <Badge kind="repost">REPOST</Badge> : <Badge kind="new">NEW</Badge>}
      {status === "applied" ? <Badge kind="applied">APPLIED</Badge> : null}
      {["recruiter_screen", "technical_screen", "interview", "onsite"].includes(status) ? (
        <Badge kind="interviewing">INTERVIEWING</Badge>
      ) : null}
      {status === "rejected" ? <Badge kind="rejected">REJECTED</Badge> : null}
      {postingStatus === "closed" || postingStatus === "ignored" || status === "closed" ? (
        <Badge kind="closed">CLOSED</Badge>
      ) : null}
      {job.previously_applied ? <Badge kind="prior">PREVIOUSLY APPLIED</Badge> : null}
    </span>
  );
}

export function formatDate(value: unknown): string {
  if (!value) return "—";
  return String(value).slice(0, 10);
}

export function JobTable({
  jobs,
  showActions = false,
}: {
  jobs: Record<string, unknown>[];
  showActions?: boolean;
}) {
  if (!jobs.length) {
    return <div className="empty">No jobs match this view.</div>;
  }
  return (
    <div className="table-wrap">
      <table className="jobs">
        <thead>
          <tr>
            <th>Company</th>
            <th>Title</th>
            <th>Location</th>
            <th>Match</th>
            <th>Lifecycle</th>
            <th>Posted</th>
            <th>First seen</th>
            <th>App status</th>
            <th>Source</th>
            <th>Open</th>
            {showActions ? <th>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const id = String(job.posting_id || job.id);
            return (
              <tr key={id}>
                <td>{String(job.company || "—")}</td>
                <td>
                  <Link href={`/dashboard/jobs/${id}`}>{String(job.title || "—")}</Link>
                  {job.previously_applied ? (
                    <div className="muted" style={{ fontSize: "0.78rem", marginTop: 2 }}>
                      Previously applied {formatDate(job.prior_applied_at)} (
                      {String(job.prior_application_status || "")})
                    </div>
                  ) : null}
                </td>
                <td>{String(job.posting_location || job.canonical_location || "—")}</td>
                <td>{formatMatch(job.match_score)}</td>
                <td>
                  <JobBadges {...job} />
                </td>
                <td>{formatDate(job.posted_date)}</td>
                <td>{formatDate(job.first_seen_at)}</td>
                <td>{String(job.application_status || "—")}</td>
                <td className="mono">{String(job.source || "—")}</td>
                <td>
                  {job.url ? (
                    <a href={String(job.url)} target="_blank" rel="noreferrer">
                      Open Job
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                {showActions ? (
                  <td>
                    <div className="actions">
                      <MarkAppliedButton
                        postingId={id}
                        applicationUrl={job.url ? String(job.url) : undefined}
                      />
                      <IgnoreButton postingId={id} />
                    </div>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
