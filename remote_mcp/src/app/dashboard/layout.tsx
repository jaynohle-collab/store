import Link from "next/link";

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/to-apply", label: "To Apply" },
  { href: "/dashboard/jobs", label: "All Jobs" },
  { href: "/dashboard/applied", label: "Applied" },
  { href: "/dashboard/interviewing", label: "Interviewing" },
  { href: "/dashboard/reposted", label: "Reposted" },
  { href: "/dashboard/discovery", label: "Discovery Runs" },
] as const;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
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
          <Link href="/">MCP home</Link>
        </div>
      </aside>
      <main className="dash-main">{children}</main>
    </div>
  );
}
