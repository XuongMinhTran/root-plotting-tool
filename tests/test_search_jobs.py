"""Process lifecycle checks; these do not require ROOT."""

from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from search_jobs import SearchBusy, SearchManager


def waiting_worker(payload, sender):
    sender.send(("progress", {"phase": "Searching", "evaluations": 12, "best_score": 3.0}))
    time.sleep(60)


def completed_worker(payload, sender):
    sender.send(("complete", {"values": [2.0, 3.0], "score": 0.0, "warnings": []}))
    sender.close()


def crashing_worker(payload, sender):
    sender.close()


class SearchLifecycleTests(unittest.TestCase):
    def manager(self, worker, **options):
        manager = SearchManager(worker, **options)
        self.addCleanup(manager.close)
        return manager

    def until_finished(self, manager, job_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = manager.get(job_id)
            if result["status"] != "running":
                return result
            time.sleep(0.05)
        self.fail("Search did not finish within five seconds")

    def test_result_is_retained_without_leaking_input_or_internal_handles(self):
        manager = self.manager(completed_worker)
        job = manager.start({"time_budget": 1, "x": [1, 2], "y": [3, 5]})
        result = self.until_finished(manager, job["job_id"])
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["result"]["values"], [2, 3])
        self.assertNotIn("x", result)
        self.assertNotIn("process", result)
        result["result"]["values"][0] = 999
        self.assertEqual(manager.get(job["job_id"])["result"]["values"][0], 2)
        self.assertEqual(manager.cancel(job["job_id"])["status"], "complete")

    def test_cancel_stops_the_worker_and_releases_the_slot(self):
        manager = self.manager(waiting_worker)
        job = manager.start({"time_budget": 60})
        process = manager._jobs[job["job_id"]]["process"]
        self.assertEqual(manager.cancel(job["job_id"])["status"], "cancelled")
        self.assertFalse(process.is_alive())
        self.assertEqual(manager.cancel(job["job_id"])["status"], "cancelled")
        second = manager.start({"time_budget": 60})
        self.assertNotEqual(job["job_id"], second["job_id"])

    def test_only_one_search_runs_at_a_time(self):
        manager = self.manager(waiting_worker)
        manager.start({"time_budget": 60})
        with self.assertRaises(SearchBusy):
            manager.start({"time_budget": 60})

    def test_unresponsive_worker_has_a_hard_deadline(self):
        manager = self.manager(waiting_worker, startup_grace=0.1)
        job = manager.start({"time_budget": 0.2})
        process = manager._jobs[job["job_id"]]["process"]
        result = self.until_finished(manager, job["job_id"])
        self.assertEqual(result["status"], "failed")
        self.assertIn("time limit", result["error"])
        self.assertFalse(process.is_alive())

    def test_crash_and_expired_job_are_reported(self):
        manager = self.manager(crashing_worker, retention=0.1)
        job = manager.start({"time_budget": 1})
        result = self.until_finished(manager, job["job_id"])
        self.assertEqual(result["status"], "failed")
        self.assertIn("stopped unexpectedly", result["error"])
        time.sleep(0.15)
        self.assertIsNone(manager.get(job["job_id"]))
        self.assertIsNone(manager.cancel("does-not-exist"))


if __name__ == "__main__":
    unittest.main()
