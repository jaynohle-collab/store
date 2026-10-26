"""Invalid model output from one provider falls through to the next."""

from __future__ import annotations

import unittest

from job_agent.auto_discovery.evaluate.providers import (
    AllProvidersUnavailableError,
    FallbackEvaluationProvider,
    InvalidModelOutputError,
    QuotaExhaustedError,
)


class _Stub:
    def __init__(self, name, result=None, error=None):
        self.name, self.result, self.error, self.calls = name, result, error, 0

    def complete_json(self, **_):
        self.calls += 1
        if self.error:
            raise self.error
        return self.result


def _validator(raw):
    if raw.get("ok") is not True:
        raise InvalidModelOutputError("bad shape")
    return raw


class FallbackValidationTests(unittest.TestCase):
    def test_invalid_output_moves_to_next_provider(self):
        bad = _Stub("bad", {"garbage": 1})
        good = _Stub("good", {"ok": True})
        chain = FallbackEvaluationProvider([bad, good])  # type: ignore[list-item]
        chain.output_validator = _validator
        self.assertEqual(chain.complete_json(system="s", user="u", schema={}), {"ok": True})
        self.assertEqual(chain.name, "good")

    def test_all_invalid_is_outage_not_rejection(self):
        chain = FallbackEvaluationProvider([_Stub("a", {}), _Stub("b", {})])  # type: ignore[list-item]
        chain.output_validator = _validator
        with self.assertRaises(AllProvidersUnavailableError) as ctx:
            chain.complete_json(system="s", user="u", schema={})
        self.assertNotIsInstance(ctx.exception, InvalidModelOutputError)
        self.assertIn("invalid output", str(ctx.exception))

    def test_mixed_invalid_and_quota_is_outage(self):
        chain = FallbackEvaluationProvider(
            [_Stub("a", {}), _Stub("b", error=QuotaExhaustedError("429"))]  # type: ignore[list-item]
        )
        chain.output_validator = _validator
        with self.assertRaises(AllProvidersUnavailableError):
            chain.complete_json(system="s", user="u", schema={})

    def test_without_validator_behaviour_unchanged(self):
        chain = FallbackEvaluationProvider([_Stub("a", {"garbage": 1})])  # type: ignore[list-item]
        self.assertEqual(chain.complete_json(system="s", user="u", schema={}), {"garbage": 1})



class RealValidatorTests(unittest.TestCase):
    def test_real_gpt_fit_validator_errors_fall_through(self):
        from job_agent.auto_discovery.evaluate.gpt_fit_v2 import validate_model_output
        good_payload = {"ok": True}
        bad = _Stub("bad", {"garbage": True})
        good = _Stub("good", good_payload)
        chain = FallbackEvaluationProvider([bad, good])  # type: ignore[list-item]
        seen = []

        def validator(raw):
            seen.append(raw)
            if raw is good_payload or raw == good_payload:
                return raw
            return validate_model_output(raw)  # raises the real error class

        chain.output_validator = validator
        self.assertEqual(chain.complete_json(system="s", user="u", schema={}), good_payload)
        self.assertEqual(chain.name, "good")


if __name__ == "__main__":
    unittest.main()
