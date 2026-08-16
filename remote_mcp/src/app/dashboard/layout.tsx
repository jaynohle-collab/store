import Link from "next/link";

import { getDashboardSessionUser } from "@/lib/dashboard/auth";

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/to-apply", label: "To Apply" },
  { href: "/dashboard/jobs", label: "All Jobs" },
  { href: "/dashboard/applied", label: "Applied" },
  { href: "/dashboard/interviewing", label: "Interviewing" },
  { href: "/dashboard/reposted", label: "Reposted" },
  { href: "/dashboard/discovery", label: "Discovery Runs" },
] as const;

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getDashboardSessionUser();

  return (
    <div className="dash-shell">
      <aside className="dash-nav">
        <div className="dash-brand">Jay Job</div>
        {NAV.map((item) => (
          <Link key={item.href} href={item.href}>
            {item.label}
          </Link>
        ))}
        <div style={{ marginTop: "auto", paddingTop: "1.5rem" }} className="muted">
          {user?.email ? <div style={{ marginBottom: "0.5rem" }}>{user.email}</div> : null}
          <a href="/auth/logout">Sign out</a>
          {" · "}
          <Link href="/">MCP home</Link>
        </div>
      </aside>
      <main className="dash-main">{children}</main>
    </div>
  );
}
