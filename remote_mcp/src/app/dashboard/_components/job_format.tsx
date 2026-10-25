/** Pure render helpers shared by server and client job tables. */

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
