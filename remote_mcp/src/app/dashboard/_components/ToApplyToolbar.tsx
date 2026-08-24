"use client";

import type { RemoteFilter, ToApplySort } from "@/lib/dashboard/query_params";

const SORT_OPTIONS: { value: ToApplySort; label: string }[] = [
  { value: "match", label: "Python Rank (high → low)" },
  { value: "gpt", label: "GPT Fit (high → low)" },
  { value: "posted", label: "Posted date (newest)" },
  { value: "first_seen", label: "First seen (newest)" },
  { value: "company", label: "Company (A → Z)" },
  { value: "title", label: "Title (A → Z)" },
];

export function ToApplyToolbar({
  initialQ,
  initialSort,
  initialRemote,
  initialPageSize,
}: {
  initialQ?: string;
  initialSort?: ToApplySort;
  initialRemote?: RemoteFilter;
  initialPageSize?: number;
}) {
  return (
    <form className="toolbar dashboard-toolbar" method="get">
      <label htmlFor="to-apply-search">Search</label>
      <input
        id="to-apply-search"
        type="search"
        name="q"
        placeholder="Company, title, location, source, skills…"
        defaultValue={initialQ || ""}
        aria-label="Search To Apply jobs"
      />
      <label htmlFor="to-apply-sort">Sort</label>
      <select
        id="to-apply-sort"
        name="sort"
        defaultValue={initialSort || "match"}
        aria-label="Sort To Apply jobs"
      >
        {SORT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <label htmlFor="to-apply-remote">Remote filter</label>
      <select
        id="to-apply-remote"
        name="remote"
        defaultValue={initialRemote || "remote_us"}
        aria-label="Remote eligibility filter"
      >
        <option value="remote_us">Remote US only</option>
        <option value="all">Show all</option>
      </select>
      <label htmlFor="to-apply-page-size">Page size</label>
      <select
        id="to-apply-page-size"
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
