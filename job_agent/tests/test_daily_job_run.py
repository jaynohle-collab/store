import unittest
from pathlib import Path

from job_agent.examples.daily_job_run import run_daily_job_run, print_daily_report
from job_agent.memory.client import MemoryStore


class SimpleToolClient:
    def __init__(self):
        self.calls = []

    async def call_tool(self, name: str, arguments: dict | None = None) -> dict:
        arguments = arguments or {}
        self.calls.append((name, arguments))
        if name == "check_duplicate":
            return {"duplicate": False, "existing_job_id": None}
        if name == "save_job_memory":
            return {"id": len([call for call in self.calls if call[0] == "save_job_memory"])}
        if name == "get_job_history":
            return []
        return {}


class DailyJobRunTests(unittest.TestCase):
    def test_run_daily_job_run_reports_loaded_jobs(self):
        sample_file = Path(__file__).resolve().parent.parent.parent / "data" / "incoming_jobs.json"
        report = run_daily_job_run(sample_file)

        self.assertEqual(report["total_jobs_received"], 2)
        self.assertEqual(report["duplicates"], 0)
        self.assertEqual(report["new_jobs"], 2)
        self.assertEqual(report["saved"], 2)
        self.assertEqual(len(report["top_matches"]), 2)

    def test_run_daily_job_run_uses_memory_store(self):
        sample_file = Path(__file__).resolve().parent.parent.parent / "data" / "incoming_jobs.json"
        tool_client = SimpleToolClient()
        memory_store = MemoryStore(tool_client=tool_client)

        report = run_daily_job_run(sample_file, memory_store=memory_store)

        self.assertEqual(report["saved"], 2)
        self.assertTrue(any(call[0] == "save_job_memory" for call in tool_client.calls))


if __name__ == "__main__":
    unittest.main()
