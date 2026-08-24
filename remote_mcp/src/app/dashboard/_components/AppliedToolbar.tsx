"use client";

import type { AppliedSort } from "@/lib/dashboard/query_params";

const SORT_OPTIONS: { value: AppliedSort; label: string }[] = [
  { value: "applied", label: "Applied date (newest)" },
  { value: "company", label: "Company (A → Z)" },
  { value: "title", label: "Title (A → Z)" },
  { value: "status", label: "Status (A → Z)" },
];

export function AppliedToolbar({
  initialQ,
  initialSort,
  initialPageSize,
}: {
  initialQ?: string;
  initialSort?: AppliedSort;
  initialPageSize?: number;
}) {
  return (
    <form className="toolbar dashboard-toolbar" method="get">
      <label htmlFor="applied-search">Search</label>
      <input
        id="applied-search"
        type="search"
        name="q"
        placeholder="Company, title, or status…"
        defaultValue={initialQ || ""}
        aria-label="Search applied applications"
      />
      <label htmlFor="applied-sort">Sort</label>
      <select
        id="applied-sort"
        name="sort"
        defaultValue={initialSort || "applied"}
        aria-label="Sort applied applications"
      >
        {SORT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <label htmlFor="applied-page-size">Page size</label>
      <select
        id="applied-page-size"
        name="pageSize"
        defaultValue={String(initialPageSize || 25)}
        aria-label="Results per page"
      >
        <option value="25">25</option>
        <option value="50">50</option>
        <option value="100">100</option>
      </select>
      <input type="hidden" name="page" value="1" />
      <button type="submit" className="btn">
        Apply
      </button>
    </form>
  );
}
