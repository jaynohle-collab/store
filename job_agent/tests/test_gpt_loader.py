import unittest

from job_agent.ingestion.gpt_loader import GPTJobLoader, GPTJobIngestionError
from job_agent.models.types import JobInput


class GPTJobLoaderTests(unittest.TestCase):
    def test_load_jobs_converts_gpt_json_to_job_input(self):
        payload = {
            "jobs": [
                {
                    "company": "Example Corp",
                    "title": "AI Researcher",
                    "url": "https://example.com/job/1",
                    "description": "Research AI models.",
                    "location": "Remote",
                    "source": "gpt",
                    "required_skills": ["python", "ml"],
                    "preferred_skills": ["nlp"],
                    "remote_status": True,
                    "salary": "$120k",
                }
            ]
        }

        job_inputs = GPTJobLoader(payload).load_jobs()

        self.assertEqual(len(job_inputs), 1)
        self.assertIsInstance(job_inputs[0], JobInput)
        self.assertEqual(job_inputs[0].company, "Example Corp")
        self.assertEqual(job_inputs[0].title, "AI Researcher")
        self.assertEqual(job_inputs[0].url, "https://example.com/job/1")
        self.assertEqual(job_inputs[0].description, "Research AI models.")
        self.assertEqual(job_inputs[0].location, "Remote")
        self.assertEqual(job_inputs[0].source, "gpt")
        self.assertEqual(job_inputs[0].metadata["required_skills"], "python, ml")
        self.assertEqual(job_inputs[0].metadata["preferred_skills"], "nlp")
        self.assertEqual(job_inputs[0].metadata["remote_status"], "True")
        self.assertEqual(job_inputs[0].metadata["salary"], "$120k")

    def test_load_jobs_missing_required_field_raises_error(self):
        payload = {
            "jobs": [
                {
                    "company": "Example Corp",
                    "title": "AI Researcher",
                    "url": "https://example.com/job/1",
                    "location": "Remote",
                    "source": "gpt",
                }
            ]
        }

        with self.assertRaises(GPTJobIngestionError):
            GPTJobLoader(payload).load_jobs()

    def test_load_jobs_requires_jobs_array(self):
        payload = {"jobs": "not a list"}

        with self.assertRaises(GPTJobIngestionError):
            GPTJobLoader(payload).load_jobs()

    def test_load_jobs_requires_payload_object(self):
        with self.assertRaises(GPTJobIngestionError):
            GPTJobLoader([]).load_jobs()


if __name__ == "__main__":
    unittest.main()
