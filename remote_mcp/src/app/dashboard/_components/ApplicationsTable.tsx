import Link from "next/link";

import { UndoAppliedButton } from "./Actions";
import { formatDate } from "./JobTable";

export function ApplicationsTable({
  apps,
  showUndo = false,
}: {
  apps: Record<string, unknown>[];
  showUndo?: boolean;
}) {
  if (!apps.length) return <div className="empty">No applications yet.</div>;
  return (
    <div className="table-wrap">
      <table className="jobs">
        <thead>
          <tr>
            <th>Company</th>
            <th>Title</th>
            <th>Status</th>
            <th>Applied</th>
            <th>Application URL</th>
            <th>Posting URL</th>
            {showUndo ? <th>Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {apps.map((a) => (
            <tr key={String(a.id)}>
              <td>{String(a.company || "—")}</td>
              <td>
                <Link href={`/dashboard/applications/${a.id}`}>{String(a.title || "—")}</Link>
              </td>
              <td>{String(a.status || "—")}</td>
              <td>{formatDate(a.applied_at)}</td>
              <td className="mono">
                {a.application_url ? (
                  <a href={String(a.application_url)} target="_blank" rel="noreferrer">
                    {String(a.application_url)}
                  </a>
                ) : (
                  "—"
                )}
              </td>
              <td className="mono">
                {a.posting_url ? (
                  <a href={String(a.posting_url)} target="_blank" rel="noreferrer">
                    Open
                  </a>
                ) : (
                  "—"
                )}
              </td>
              {showUndo ? (
                <td>
                  {String(a.status) === "applied" ? (
                    <UndoAppliedButton applicationId={String(a.id)} />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
