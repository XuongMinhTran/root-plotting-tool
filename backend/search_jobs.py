"""Short-lived parameter searches, isolated from the web server's ROOT state.

Workers own their ROOT interpreter. Cancellation and the hard deadline stop the
process, including a numerical library call that does not return voluntarily.
Only progress/results are retained in memory; input data never go to disk.
"""

import atexit
import copy
import math
import multiprocessing
import threading
import time
import uuid


class SearchBusy(ValueError):
    pass


def _finite_json(value):
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, dict):
        return all(_finite_json(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return all(_finite_json(item) for item in value)
    return value is None or isinstance(value, (str, int, bool))


def _run_search(payload, sender):
    last_update = 0.0

    def progress(value):
        nonlocal last_update
        now = time.monotonic()
        if now - last_update >= 0.25 and _finite_json(value):
            sender.send(("progress", value))
            last_update = now

    try:
        from parameter_search import search
        result = search(payload, progress)
        if not _finite_json(result):
            raise ValueError("The search could not find finite starting values. Try narrower parameter ranges.")
        sender.send(("complete", result))
    except ValueError as error:
        sender.send(("failed", str(error)))
    except Exception:
        sender.send(("failed", "The search could not finish. Check the function and parameter ranges, then try again."))
    finally:
        sender.close()


class SearchManager:
    def __init__(self, worker=_run_search, *, startup_grace=30, retention=900):
        self._worker = worker
        self._context = multiprocessing.get_context("spawn")
        self._lock = threading.RLock()
        self._jobs = {}
        self._startup_grace = startup_grace
        self._retention = retention
        self._closed = False

    def _prune(self):
        now = time.monotonic()
        expired = [key for key, job in self._jobs.items()
                   if job["status"] != "running" and now - job["finished"] > self._retention]
        for key in expired:
            del self._jobs[key]
        while len(self._jobs) >= 32:
            finished = [(job["finished"], key) for key, job in self._jobs.items()
                        if job["status"] != "running"]
            if not finished:
                break
            del self._jobs[min(finished)[1]]

    def start(self, payload):
        with self._lock:
            self._prune()
            if self._closed:
                raise SearchBusy("The search service is stopping. Please try again shortly.")
            if any(job["status"] == "running" for job in self._jobs.values()):
                raise SearchBusy("Another parameter search is running. Wait for it to finish, or cancel your current search.")
            receiver, sender = self._context.Pipe(duplex=False)
            process = self._context.Process(target=self._worker, args=(copy.deepcopy(payload), sender), daemon=True)
            job_id = uuid.uuid4().hex
            job = dict(job_id=job_id, status="running", progress={"phase": "Preparing search", "evaluations": 0,
                       "best_score": None, "elapsed_seconds": 0}, process=process, receiver=receiver,
                       started=time.monotonic(), finished=None, budget=float(payload["time_budget"]))
            try:
                process.start()
            except Exception:
                receiver.close()
                sender.close()
                raise
            sender.close()
            self._jobs[job_id] = job
            threading.Thread(target=self._monitor, args=(job,), daemon=True).start()
            return self._snapshot(job)

    @staticmethod
    def _stop(process):
        if process.is_alive():
            process.terminate()
        process.join(timeout=0.5)
        if process.is_alive():
            process.kill()
            process.join(timeout=0.5)

    def _finish(self, job, status, error=None, result=None):
        # Called under the manager lock, so cancel/completion cannot race.
        if job["status"] != "running":
            return
        self._stop(job["process"])
        job["status"] = status
        job["finished"] = time.monotonic()
        job["progress"]["elapsed_seconds"] = round(job["finished"] - job["started"], 2)
        if error:
            job["error"] = error
        if result is not None:
            job["result"] = result

    def _monitor(self, job):
        receiver = job["receiver"]
        try:
            while True:
                with self._lock:
                    if job["status"] != "running":
                        return
                    if receiver.poll():
                        try:
                            kind, value = receiver.recv()
                        except (EOFError, OSError):
                            self._finish(job, "failed", "The search stopped unexpectedly. Try smaller parameter ranges or fewer parameters.")
                            return
                        if kind == "progress" and isinstance(value, dict) and _finite_json(value):
                            job["progress"].update(value)
                        elif kind == "complete" and isinstance(value, dict) and _finite_json(value):
                            self._finish(job, "complete", result=value)
                            return
                        elif kind == "failed":
                            self._finish(job, "failed", str(value))
                            return
                    elif not job["process"].is_alive():
                        self._finish(job, "failed", "The search stopped unexpectedly. Try smaller parameter ranges or fewer parameters.")
                        return
                    if time.monotonic() - job["started"] > job["budget"] + self._startup_grace:
                        self._finish(job, "failed", "The search reached its time limit before it could return usable values. Narrow the parameter ranges and try again.")
                        return
                time.sleep(0.05)
        finally:
            receiver.close()

    @staticmethod
    def _snapshot(job):
        return copy.deepcopy({key: job[key] for key in ("job_id", "status", "progress", "result", "error") if key in job})

    def get(self, job_id):
        with self._lock:
            self._prune()
            job = self._jobs.get(job_id)
            return self._snapshot(job) if job else None

    def cancel(self, job_id):
        with self._lock:
            self._prune()
            job = self._jobs.get(job_id)
            if not job:
                return None
            self._finish(job, "cancelled")
            return self._snapshot(job)

    def close(self):
        with self._lock:
            self._closed = True
            for job in self._jobs.values():
                self._finish(job, "cancelled")


manager = SearchManager()
atexit.register(manager.close)
