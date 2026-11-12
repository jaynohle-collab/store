"""Create a private offline keyword-review report from saved ATS snapshots.

python -m job_agent.examples.keyword_review --candidates saved-listings.json \
    --policy /private/search-policy.json --output /private/review.json

Never fetches URLs, resolves an LLM, writes to MCP, or applies to jobs.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from job_agent.review.keyword import KeywordPolicy, review_candidates


def _read(path: Path):
    if path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("input file exceeds 32 MiB")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", required=True, type=Path)
    parser.add_argument("--policy", required=True, type=Path)
    parser.add_argument("--applied-urls", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        report = review_candidates(_read(args.candidates), KeywordPolicy.from_dict(_read(args.policy)),
                                   applied_urls=_read(args.applied_urls) if args.applied_urls else None)
        # Exclusive create prevents accidentally overwriting an input or report.
        # Restrictive permissions protect inferred preferences in matched terms.
        import os
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
    except (OSError, ValueError, TypeError) as exc:
        parser.error(str(exc))
    print(json.dumps(report["counts"], sort_keys=True))


if __name__ == "__main__":
    main()
