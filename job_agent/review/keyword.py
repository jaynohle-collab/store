"""Deterministic keyword review, separate from GPT admission and eligibility.

Consumes saved listing snapshots and a caller-supplied private policy. This
module never resolves a provider, fetches a URL, connects to a store, submits a
batch, or changes application state. Scores express textual overlap only.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

VERSION = "keyword-review-v1"
LABEL = "Keyword match, unverified"
MAX_ROWS = 20_000


def _text(value: str) -> str:
    return re.sub(r"[\s\-‐‑–—]+", " ", unicodedata.normalize("NFKC", value).casefold()).strip()


def _contains(text: str, phrase: str) -> bool:
    return bool(re.search(r"(?<!\w)" + re.escape(_text(phrase)) + r"(?!\w)", _text(text)))


def _terms(value: object, name: str) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > 200:
        raise ValueError(f"{name} must be a list of at most 200 phrases")
    if any(not isinstance(v, str) or not v.strip() or len(v) > 100 for v in value):
        raise ValueError(f"{name} contains an invalid phrase")
    normalized = {_text(v) for v in value}
    if "" in normalized:
        raise ValueError(f"{name} contains a normalized-empty phrase")
    return tuple(sorted(normalized))


@dataclass(frozen=True)
class KeywordPolicy:
    policy_version: str
    role_terms: tuple[str, ...]
    keyword_groups: tuple[tuple[str, tuple[str, ...]], ...]
    seniority_terms: tuple[str, ...]
    excluded_title_terms: tuple[str, ...]
    countries: tuple[str, ...]
    work_modes: tuple[str, ...]
    minimum_score: int = 20
    stronger_score: int = 50

    @classmethod
    def from_dict(cls, raw: dict) -> "KeywordPolicy":
        if not isinstance(raw, dict):
            raise ValueError("policy must be an object")
        allowed = set(cls.__dataclass_fields__)
        if set(raw) - allowed:
            raise ValueError("unknown policy fields")
        version = raw.get("policy_version")
        if not isinstance(version, str) or not version.strip() or len(version) > 100:
            raise ValueError("policy_version is required")
        groups = raw.get("keyword_groups", {})
        if not isinstance(groups, dict) or len(groups) > 100:
            raise ValueError("keyword_groups must be an object with at most 100 groups")
        if any(not isinstance(k, str) or not k.strip() or len(k) > 100 for k in groups):
            raise ValueError("invalid keyword group name")
        roles = _terms(raw.get("role_terms", []), "role_terms")
        aliases = tuple(sorted((k, _terms(v, k)) for k, v in groups.items()))
        if not roles and not any(v for _, v in aliases):
            raise ValueError("at least one role phrase or keyword group is required")
        minimum = raw.get("minimum_score", 20)
        stronger = raw.get("stronger_score", 50)
        if type(minimum) is not int or type(stronger) is not int or not 0 <= minimum <= stronger <= 100:
            raise ValueError("thresholds must be integers with 0 <= minimum <= stronger <= 100")
        countries = _terms(raw.get("countries", []), "countries")
        if any(not re.fullmatch(r"[a-z]{2}", c) for c in countries):
            raise ValueError("countries must contain ISO two-letter country codes")
        modes = _terms(raw.get("work_modes", []), "work_modes")
        if set(modes) - {"remote", "hybrid", "onsite"}:
            raise ValueError("work_modes must be remote, hybrid, or onsite")
        return cls(version, roles, aliases,
                   _terms(raw.get("seniority_terms", []), "seniority_terms"),
                   _terms(raw.get("excluded_title_terms", []), "excluded_title_terms"),
                   countries, modes, minimum, stronger)

    def fingerprint(self) -> str:
        # Do not expose raw private search preferences in shared logs or code.
        data = json.dumps({k: getattr(self, k) for k in self.__dataclass_fields__}, sort_keys=True)
        return hashlib.sha256(data.encode()).hexdigest()


def normalized_posting_url(raw: str) -> str | None:
    """Local link hygiene, NOT DNS/SSRF validation or official-domain verification."""
    if not isinstance(raw, str) or not raw or len(raw) > 4096:
        return None
    if any(c.isspace() or ord(c) < 33 or ord(c) == 127 for c in raw) or "\\" in raw:
        return None
    try:
        parsed = urlsplit(raw)
        host = parsed.hostname or ""
        if parsed.scheme not in {"http", "https"} or not host or parsed.username or parsed.password:
            return None
        if parsed.port not in {None, 80, 443} or "." not in host:
            return None
        safe_host = host.rstrip(".")
        if safe_host.endswith((".localhost", ".local", ".internal", ".test", ".lan", ".home", ".invalid", ".example", ".home.arpa")) or safe_host == "home.arpa":
            return None
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            return None
        if not parsed.path.strip("/"):
            return None
        if re.fullmatch(r"[0-9.]+", host):
            try:
                ipaddress.ip_address(host)
            except ValueError:
                return None
    except ValueError:
        return None
    # Only unequivocal marketing parameters are dropped. Preserve other query
    # names (including source/ref), which can encode a genuine posting identity.
    query = sorted(((k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
                    if not k.casefold().startswith("utm_") and k.casefold() not in {"gclid", "fbclid"}), key=lambda pair: pair[0])
    authority = parsed.netloc.casefold()
    if (parsed.scheme, parsed.port) in {("https", 443), ("http", 80)}:
        authority = parsed.hostname.casefold()
    return urlunsplit((parsed.scheme, authority, parsed.path.rstrip("/"), urlencode(query), parsed.fragment))


def location_signals(location: str) -> tuple[str, str]:
    """Country/work-mode claims from listing location only; never eligibility.

    Unknown, mixed, and negated claims are retained for human review. City/state
    inference and description-wide 'remote' substring guesses are not used.
    """
    text = _text(location)
    countries = {c.casefold() for c in re.findall(r"\(country:\s*([a-z]{2,3})\)", text)}
    countries = {"us" if c == "usa" else c for c in countries}
    for code, aliases in {"us": ("united states", "usa", "u.s.", "us"),
                          "ca": ("canada",), "gb": ("united kingdom", "uk"),
                          "de": ("germany",), "in": ("india",),
                          "au": ("australia",)}.items():
        if any(_contains(text, alias) for alias in aliases):
            countries.add(code)
    negated = bool(re.search(r"\b(no|not|except|excluding|exclude|outside|non|unavailable|ineligible|prohibited|without)\b", text))
    # Only wholly understood location labels receive an inferred country. This
    # deliberately leaves city/state strings and unrecognized country names
    # unknown instead of allowing a known US token to mask another geography.
    remainder = re.sub(r"\(country:\s*[a-z]{2,3}\)", " ", text)
    for phrase in ("united states", "united kingdom", "u.s.", "country", "on site", "in office", "remote", "hybrid", "onsite", "canada", "germany", "india", "australia", "usa", "us", "uk", "only"):
        remainder = re.sub(r"(?<!\w)" + re.escape(phrase) + r"(?!\w)", " ", remainder)
    ambiguous_country = bool(re.search(r"[a-z0-9]|[/;]", remainder))
    country = next(iter(countries)) if len(countries) == 1 and not negated and not ambiguous_country else "unknown"
    modes = set()
    if _contains(text, "remote"):
        modes.add("remote")
    if _contains(text, "hybrid"):
        modes.add("hybrid")
    if any(_contains(text, x) for x in ("onsite", "on site", "in office")):
        modes.add("onsite")
    mode = next(iter(modes)) if len(modes) == 1 and not negated else "unknown"
    return country, mode


def _validate(row: dict) -> str | None:
    for name in ("title", "company", "source", "url"):
        if not isinstance(row.get(name), str) or not row[name].strip():
            return f"missing_or_invalid_{name}"
    for name in ("location", "external_job_id", "description", "posted_date"):
        if row.get(name) is not None and not isinstance(row[name], str):
            return f"invalid_{name}"
    for name, maximum in (("title", 500), ("company", 500), ("source", 500),
                          ("external_job_id", 500), ("location", 2000), ("posted_date", 500)):
        if len(row.get(name) or "") > maximum:
            return f"{name}_too_large"
    if len(row.get("description") or "") > 1_000_000:
        return "description_too_large"
    if not normalized_posting_url(row["url"]):
        return "invalid_or_nonposting_url"
    return None


def review_candidates(rows: list[dict], policy: KeywordPolicy, *, applied_urls: list[str] | None = None) -> dict:
    """Review snapshots; returns every distinct candidate, not just a top-K slice.

    Optional applied_urls is a trusted local history snapshot. Absence means
    application history was not checked. A non-match is not proof never applied.
    Dedupe is snapshot-level exact identity only, not canonical/repost detection.
    """
    if not isinstance(rows, list) or len(rows) > MAX_ROWS or any(not isinstance(r, dict) for r in rows):
        raise ValueError(f"candidates must be a list of at most {MAX_ROWS} objects")
    if applied_urls is not None and (not isinstance(applied_urls, list) or any(not isinstance(u, str) for u in applied_urls)):
        raise ValueError("applied_urls must be a list of strings")
    applied = {normalized_posting_url(u) for u in applied_urls or []}
    applied.discard(None)
    invalid, valid = [], []
    for index, row in enumerate(rows):
        reason = _validate(row)
        if reason:
            invalid.append({"input_index": index, "reason": reason})
        else:
            valid.append(row)
    # Union matching URLs and source+company+ATS IDs, including transitive chains.
    parents = list(range(len(valid)))
    def root(i: int) -> int:
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    identities = {}
    for i, row in enumerate(valid):
        keys = [("url", normalized_posting_url(row["url"]))]
        if (row.get("external_job_id") or "").strip():
            keys.append(("ats", _text(row["source"]), _text(row["company"]), row["external_job_id"].strip()))
        for key in keys:
            if key in identities:
                parents[root(i)] = root(identities[key])
            else:
                identities[key] = i
    groups = {}
    for i, row in enumerate(valid):
        groups.setdefault(root(i), []).append(row)
    items = []
    for duplicates in groups.values():
        row = min(duplicates, key=lambda r: (-(len(r.get("description") or "")),
                                             json.dumps(r, sort_keys=True)))
        url = normalized_posting_url(row["url"])
        title, description = row["title"], row.get("description") or ""
        roles = [term for term in policy.role_terms if _contains(title, term)]
        seniority = [term for term in policy.seniority_terms if _contains(title, term)]
        hits = [{"group": name, "aliases": [a for a in aliases if _contains(title + " " + description, a)]}
                for name, aliases in policy.keyword_groups]
        hits = [h for h in hits if h["aliases"]]
        country, mode = location_signals(row.get("location") or "")
        warnings = []
        if not description.strip():
            warnings.append("description_missing")
        if policy.countries and country == "unknown":
            warnings.append("country_needs_checking")
        if policy.work_modes and mode == "unknown":
            warnings.append("work_mode_needs_checking")
        if policy.seniority_terms and not seniority:
            warnings.append("seniority_needs_checking")
        if len({(_text(r["title"]), _text(r.get("location") or "")) for r in duplicates}) > 1:
            warnings.append("duplicate_metadata_conflict")
        reasons = []
        if "duplicate_metadata_conflict" not in warnings:
            if re.search(r"\b(closed|filled|expired|archived)\b", _text(title)):
                reasons.append("title_says_closed")
            if any(_contains(title, term) for term in policy.excluded_title_terms):
                reasons.append("excluded_title_term")
        # Conflicting duplicates stay visible for review, not silently discarded.
        if "duplicate_metadata_conflict" not in warnings:
            if policy.countries and country != "unknown" and country not in policy.countries:
                reasons.append("listing_country_outside_policy")
            if policy.work_modes and mode != "unknown" and mode not in policy.work_modes:
                reasons.append("listing_work_mode_outside_policy")
        previously_applied = any(normalized_posting_url(r["url"]) in applied for r in duplicates)
        if previously_applied:
            reasons.append("applied_in_supplied_history")
        points = {"role_title": 40 if roles else 0, "keyword_groups": min(30, len(hits) * 5),
                  "seniority_title": 10 if seniority else 0,
                  "listing_country": 10 if policy.countries and country in policy.countries else 0,
                  "listing_work_mode": 10 if policy.work_modes and mode in policy.work_modes else 0}
        score = sum(points.values())
        if not roles and not hits:
            reasons.append("no_role_or_keyword_match")
        if score < policy.minimum_score:
            reasons.append("below_keyword_threshold")
        bucket = "filtered" if reasons else "needs_checking" if warnings else "stronger" if score >= policy.stronger_score else "broader"
        items.append({"candidate_key": hashlib.sha256(url.encode()).hexdigest(),
                      "title": title, "company": row["company"], "source": row["source"],
                      "external_job_id": row.get("external_job_id") or "", "normalized_url": url,
                      "identity_aliases": [dict(zip(("normalized_url", "source", "company", "external_job_id"), alias))
                                           for alias in sorted({(normalized_posting_url(r["url"]), r["source"], r["company"], r.get("external_job_id") or "") for r in duplicates})],
                      "url": row["url"], "location_text": row.get("location") or "",
                      "posted_date_text": row.get("posted_date") or "",
                      "label": LABEL, "bucket": bucket, "keyword_score": score,
                      "score_components": points, "matched_role_terms": roles,
                      "matched_seniority_terms": seniority, "matched_keyword_groups": hits,
                      "listing_country_signal": country, "listing_work_mode_signal": mode,
                      "eligibility_status": "unverified", "open_status": "unverified",
                      "link_status": "unverified", "application_action": "none",
                      "application_history": "matched" if previously_applied else "not_found_in_supplied_snapshot" if applied_urls is not None else "not_checked",
                      "duplicate_count": len(duplicates) - 1, "warnings": warnings, "filter_reasons": reasons})
    order = {"stronger": 0, "broader": 1, "needs_checking": 2, "filtered": 3}
    items.sort(key=lambda r: (order[r["bucket"]], -r["keyword_score"], r["candidate_key"]))
    return {"version": VERSION, "policy_version": policy.policy_version,
            "policy_fingerprint": policy.fingerprint(), "label": LABEL,
            "llm_calls": 0, "application_actions": 0, "dedupe_scope": "supplied_snapshot_only",
            "counts": {"input": len(rows), "invalid": len(invalid), "distinct": len(items),
                       "duplicates": len(valid) - len(items),
                       **{bucket: sum(r["bucket"] == bucket for r in items) for bucket in order}},
            "items": items, "invalid_rows": invalid}
