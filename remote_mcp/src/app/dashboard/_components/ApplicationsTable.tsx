import Link from "next/link";

import { formatDate } from "./JobTable";

export function ApplicationsTable({ apps }: { apps: Record<string, unknown>[] }) {
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
