import Link from "next/link";

import { getApplicationDetail } from "@/lib/db/dashboard";
import { StatusUpdateForm } from "../../_components/Actions";
import { formatDate } from "../../_components/JobTable";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export default async function ApplicationDetailPage({ params }: Ctx) {
  const { id } = await params;
  let detail: Awaited<ReturnType<typeof getApplicationDetail>> = null;
  let error: string | null = null;
  try {
    detail = await getApplicationDetail(id);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load";
  }

  if (error) return <div className="panel muted">{error}</div>;
  if (!detail) return <div className="empty">Application not found.</div>;

  const { application: a, events } = detail;

  return (
    <>
      <div className="dash-header">
        <div>
          <h1>
            {String(a.company)} — {String(a.title)}
          </h1>
          <p>
            Status: <strong>{String(a.status)}</strong>
          </p>
        </div>
        <Link className="btn btn-ghost" href={`/dashboard/jobs/${a.posting_id}`}>
          View posting
        </Link>
      </div>

      <div className="detail-grid">
        <div className="panel">
          <h2>Application</h2>
          <div>
            <Row label="Applied at" value={formatDate(a.applied_at)} />
            <Row label="Application URL" value={String(a.application_url || "—")} />
            <Row label="Posting URL" value={String(a.posting_url || "—")} />
            <Row label="Resume version" value={String(a.resume_version || "—")} />
            <Row label="Cover letter" value={String(a.cover_letter_version || "—")} />
            <Row label="Notes" value={String(a.notes || "—")} />
          </div>
          <StatusUpdateForm
            applicationId={String(a.id)}
            currentStatus={String(a.status || "applied")}
          />
        </div>
        <div className="panel">
          <h2>Timeline</h2>
          {!events.length ? <p className="muted">No events yet.</p> : null}
          <ul className="timeline">
            {events.map((ev) => (
              <li key={String(ev.id)}>
                <strong>{String(ev.event_type)}</strong>
                <div className="muted">{formatDate(ev.event_at)}</div>
                {ev.notes ? <div>{String(ev.notes)}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: "0.45rem" }}>
      <strong>{label}:</strong>{" "}
      {value.startsWith("http") ? (
        <a href={value} target="_blank" rel="noreferrer" className="mono">
          {value}
        </a>
      ) : (
        value
      )}
    </div>
  );
}
