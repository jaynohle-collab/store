"use client";

export function JobsSearchForm({
  initialQ,
  initialSort,
  initialLifecycle,
}: {
  initialQ?: string;
  initialSort?: string;
  initialLifecycle?: string;
}) {
  return (
    <form className="toolbar" method="get">
      <input
        type="search"
        name="q"
        placeholder="Search company, title, URL…"
        defaultValue={initialQ || ""}
      />
      <select name="sort" defaultValue={initialSort || "newest"}>
        <option value="newest">Newest discovered</option>
        <option value="posted">Posted date</option>
        <option value="match">Match score</option>
        <option value="company">Company</option>
      </select>
      <select name="lifecycle" defaultValue={initialLifecycle || "all"}>
        <option value="all">All lifecycle</option>
        <option value="new">New only</option>
        <option value="repost">Repost only</option>
      </select>
      <button type="submit" className="btn">
        Filter
      </button>
    </form>
  );
}
