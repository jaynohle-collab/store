import Link from "next/link";

export default function DashboardUnauthorizedPage() {
  return (
    <div className="empty" style={{ maxWidth: 520, margin: "3rem auto" }}>
      <h1>Access denied</h1>
      <p className="muted">
        You are signed in, but this personal dashboard is limited to an allowlisted email.
        Verify your email in Auth0 if needed, then sign out and try again.
      </p>
      <p style={{ marginTop: "1.25rem" }}>
        <a href="/auth/logout">Sign out</a>
        {" · "}
        <Link href="/">MCP home</Link>
      </p>
    </div>
  );
}
