import Link from "next/link";

import type { PaginationMeta } from "@/lib/dashboard/query_params";
import { buildDashboardQueryString } from "@/lib/dashboard/query_params";

export function DashboardPagination({
  basePath,
  query,
  pagination,
}: {
  basePath: string;
  query: Record<string, string | number | undefined | null>;
  pagination: PaginationMeta;
}) {
  if (pagination.total === 0) {
    return <p className="muted pagination-meta">No matching results.</p>;
  }

  const prevQuery = buildDashboardQueryString({ ...query, page: pagination.page - 1 });
  const nextQuery = buildDashboardQueryString({ ...query, page: pagination.page + 1 });

  return (
    <nav className="pagination-bar" aria-label="Results pagination">
      <p className="pagination-meta">
        Showing {pagination.rangeStart}–{pagination.rangeEnd} of {pagination.total}
      </p>
      <div className="pagination-controls">
        {pagination.hasPrevious ? (
          <Link className="btn btn-ghost" href={`${basePath}${prevQuery}`}>
            Previous
          </Link>
        ) : (
          <span className="btn btn-ghost" aria-disabled="true">
            Previous
          </span>
        )}
        <span className="pagination-page">
          Page {pagination.page} of {pagination.totalPages || 1}
        </span>
        {pagination.hasNext ? (
          <Link className="btn btn-ghost" href={`${basePath}${nextQuery}`}>
            Next
          </Link>
        ) : (
          <span className="btn btn-ghost" aria-disabled="true">
            Next
          </span>
        )}
      </div>
    </nav>
  );
}

export function PageSizeSelect({
  query,
  pageSize,
}: {
  query: Record<string, string | number | undefined | null>;
  pageSize: number;
}) {
  return (
    <form className="page-size-form" method="get">
      {Object.entries(query).map(([key, value]) =>
        key === "pageSize" || key === "page" || value == null || value === "" ? null : (
          <input key={key} type="hidden" name={key} value={String(value)} />
        ),
      )}
      <label htmlFor="pageSize">Rows per page</label>
      <select id="pageSize" name="pageSize" defaultValue={String(pageSize)}>
        {[25, 50, 100].map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
      <input type="hidden" name="page" value="1" />
      <button type="submit" className="btn btn-ghost">
        Apply
      </button>
    </form>
  );
}
