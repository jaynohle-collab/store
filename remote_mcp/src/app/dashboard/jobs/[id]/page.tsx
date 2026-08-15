import Link from "next/link";

import { getDashboardJob } from "@/lib/db/dashboard";
import { StatusUpdateForm, MarkAppliedButton, IgnoreButton } from "../../_components/Actions";
import { JobBadges, formatDate, formatMatch } from "../../_components/JobTable";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export default async function JobDetailPage({ params }: Ctx) {
  const { id } = await params;
  let job: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    job = await getDashboardJob(id);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  if (error) return <div className="panel muted">{error}</div>;
  if (!job) return <div className="empty">Job not found.</div>;

  return (
    <>
      <div className="dash-header">
        <div>
          <h1>
            {String(job.company)} — {String(job.title)}
          </h1>
          <p>
            <JobBadges {...job} />
          </p>
        </div>
        <div className="actions">
          {job.url ? (
            <a className="btn" href={String(job.url)} target="_blank" rel="noreferrer">
              Open Job
            </a>
          ) : null}
          {!job.application_id ? (
            <>
              <MarkAppliedButton
                postingId={id}
                applicationUrl={job.url ? String(job.url) : undefined}
              />
              <IgnoreButton postingId={id} />
            </>
          ) : (
            <Link className="btn btn-ghost" href={`/dashboard/applications/${job.application_id}`}>
              View application
            </Link>
          )}
        </div>
      </div>

      <div className="detail-grid">
        <div className="panel">
          <h2>Posting</h2>
          <dl className="muted">
            <Row label="Match score" value={formatMatch(job.match_score)} />
            <Row label="Recommendation" value={String(job.recommendation || "—")} />
            <Row label="Location" value={String(job.location || job.canonical_location || "—")} />
            <Row label="Remote" value={String(job.remote_status || "—")} />
            <Row label="Posted" value={formatDate(job.posted_date)} />
            <Row label="First seen" value={formatDate(job.first_seen_at)} />
            <Row label="Last seen" value={formatDate(job.last_seen_at)} />
            <Row label="Source" value={String(job.source || "—")} />
            <Row label="External ID" value={String(job.external_job_id || "—")} />
            <Row label="URL" value={String(job.url || "—")} />
            <Row label="Is repost" value={job.is_repost ? "yes" : "no"} />
          </dl>
          {job.previously_applied ? (
            <p>
              Previously applied on {formatDate(job.prior_applied_at)} — status{" "}
              {String(job.prior_application_status)}. This posting is not automatically applied.
            </p>
          ) : null}
        </div>
        <div className="panel">
          <h2>Evaluation</h2>
          <p className="muted">
            Candidate match_score is Python-owned and separate from canonical similarity.
          </p>
          <dl>
            <Row label="Evaluated" value={formatDate(job.evaluated_at)} />
            <Row label="Scoring version" value={String(job.scoring_version || "—")} />
            <Row label="Profile version" value={String(job.profile_version || "—")} />
            <Row label="Reason" value={String(job.evaluation_reason || "—")} />
          </dl>
          {job.application_id ? (
            <>
              <h2 style={{ marginTop: "1rem" }}>Application</h2>
              <StatusUpdateForm
                applicationId={String(job.application_id)}
                currentStatus={String(job.application_status || "applied")}
              />
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: "0.45rem" }}>
      <strong style={{ color: "var(--text)" }}>{label}:</strong> {value}
    </div>
  );
}
