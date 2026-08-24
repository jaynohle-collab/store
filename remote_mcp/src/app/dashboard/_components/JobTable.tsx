import Link from "next/link";

import {
  GPT_FIT_LABEL,
  GPT_FIT_TOOLTIP,
  PYTHON_RANK_LABEL,
  PYTHON_RANK_TOOLTIP,
  formatGptFit,
  formatPythonRank,
  gptFitTitle,
} from "@/lib/dashboard/scores";

import { MarkAppliedButton, IgnoreButton } from "./Actions";

export { formatPythonRank as formatMatch } from "@/lib/dashboard/scores";

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
            <th title={PYTHON_RANK_TOOLTIP}>{PYTHON_RANK_LABEL}</th>
            <th title={GPT_FIT_TOOLTIP}>{GPT_FIT_LABEL}</th>
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
                <td>{formatPythonRank(job.match_score)}</td>
                <td title={gptFitTitle(job.gpt_evaluation_version)} aria-label={`${GPT_FIT_LABEL}: ${formatGptFit(job.gpt_relevance_score)} (${job.gpt_evaluation_version ? String(job.gpt_evaluation_version) : "no evidence"})`}>
                  {formatGptFit(job.gpt_relevance_score)}
                  {job.gpt_evaluation_version ? (
                    <span className="muted" style={{ display: "block", fontSize: "0.72rem" }}>
                      {String(job.gpt_evaluation_version)}
                    </span>
                  ) : null}
                </td>
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
