"""serve/setup_web.py, the model manager: its verdicts follow setup.py's rules, it reads setup.py's output line by line
(a download's \\r progress kept apart), and it answers only this PC's own page.

Run: python -m unittest serve.test_setup_web
"""
from __future__ import annotations

import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import setup_web as W  # noqa: E402


def verdict(model, ram, vram, family="qwen", gpu_ok=True, amd=False, free=None):
    return W.fit(family, model, ram, vram, gpu_ok, amd, free)


class Fit(unittest.TestCase):
    def codes(self, v):
        return [r["code"] for r in v["reasons"]]

    def test_ram_decides_the_size(self):
        # docs/MODELS.md "Will it fit?": the experts + about 10 GB of RAM
        self.assertEqual(verdict("IQ2_XS", 64, 16)["level"], "ok")
        self.assertEqual(verdict("IQ3_S", 64, 16)["level"], "ok")           # 50.3 + 10 <= 64
        self.assertEqual(verdict("IQ3_S", 48, 12)["level"], "no")           # nor in the low-RAM mode on 12 GB
        # the Coder on 32 GB: 23.4 + 10 > 32, so the low-RAM mode - its resident variant with a 12 GB card
        v = verdict("IQ1_M", 32, 12, family="coder")
        self.assertEqual(v["level"], "ok")
        self.assertIn("low_ram_resident", self.codes(v))

    def test_low_ram_mode(self):
        # a 32 GB PC with a 24 GB GPU runs Q2_0 in the low-RAM mode (docs/MODELS.md): resident, the card holds 19 GB
        v = verdict("Q2_0", 32, 24)
        self.assertEqual(v["level"], "ok")
        self.assertIn("low_ram_resident", self.codes(v))
        # the Coder on 24 GB with a 12 GB card: the rest does not fit beside the OS, it is read through the file cache
        v = verdict("IQ1_M", 24, 12, family="coder")
        self.assertEqual(v["level"], "slow")
        self.assertIn("low_ram", self.codes(v))
        self.assertEqual(verdict("Q2_0", 32, 12)["level"], "no")         # 32 - 6 + 7 < 34: not even mapped

    def test_small_card_is_slower(self):
        v = verdict("Q2_0", 64, 8)
        self.assertEqual(v["level"], "slow")
        self.assertIn("vram_small", self.codes(v))
        self.assertEqual(verdict("Q2_0", 64, 4)["level"], "no")

    def test_no_gpu(self):
        v = verdict("Q2_0", 128, 0, gpu_ok=False)
        self.assertEqual(v["level"], "no")
        self.assertIn("no_gpu", self.codes(v))

    def test_unsloth_budget(self):
        self.assertEqual(verdict("UD-Q4_K_XL", 96, 16, family="unsloth")["level"], "ok")    # 77 + 10 <= 96
        v = verdict("UD-Q4_K_XL", 64, 16, family="unsloth")
        self.assertEqual(v["level"], "slow")
        self.assertIn("ram_budget", self.codes(v))
        self.assertEqual(verdict("UD-Q4_K_XL", 32, 16, family="unsloth")["level"], "no")
        self.assertIn("nvidia_only", self.codes(verdict("UD-Q4_K_XL", 96, 16, family="unsloth", amd=True)))

    def test_disk_is_a_warning(self):
        v = verdict("Q2_0", 64, 16, free=10)
        self.assertEqual(v["level"], "ok")
        self.assertIn("disk", self.codes(v))

    def test_catalog_has_every_family_size(self):
        hw = {"ram_gb": 64, "gpus": [{"vram_gb": 16, "vendor": "nvidia", "problem": None}], "free_gb": 500}
        keys = {f"{m['family']}/{m['model']}" for m in W.catalog(hw)}
        self.assertIn("qwen/IQ3_S", keys)
        self.assertIn("coder/IQ1_M", keys)
        self.assertIn("unsloth/UD-IQ4_XS", keys)
        self.assertNotIn("swift/Q2_0", keys)                               # Swift 1.5 has no Q2_0 in setup


class Output(unittest.TestCase):
    def lines(self, data: bytes):
        job = W.Job.__new__(W.Job)
        job.lines, job.progress = [], ""

        class P:
            def __init__(self, chunks):
                self.chunks = list(chunks)

            def read1(self, n):
                return self.chunks.pop(0) if self.chunks else b""

        class Proc:
            stdout = P([data[i:i + 7] for i in range(0, len(data), 7)])   # odd chunks: a \r\n split across reads

            def wait(self):
                return 0

        job.proc = Proc()
        job._read()
        return job

    def test_windows_and_unix_lines(self):
        job = self.lines(b"one\r\ntwo\nthree\r\n")
        self.assertEqual(job.lines, ["one", "two", "three"])

    def test_progress_rewrites(self):
        job = self.lines(b"start\n\r  model: 1 GB   \r  model: 2 GB   ")
        self.assertEqual(job.lines, ["start", "  model: 2 GB"])          # setup's indentation kept
        job = self.lines(b"\r  a: 1 GB\r  a: 5 GB\ndone\n")
        self.assertEqual(job.lines, ["  a: 5 GB", "done"])


class Http(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), W.handler(0))
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def call(self, path, body=None, headers=None):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers=headers or {},
                                     data=None if body is None else json.dumps(body).encode(),
                                     method="GET" if body is None else "POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_context(self):
        self.assertEqual(self.call("/manage/api/context"), (200, {"embedded": False}))

    def test_page(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/", timeout=10) as r:
            self.assertIn(b'src="web/setup.js"', r.read())

    def test_other_host_refused(self):
        self.assertEqual(self.call("/manage/api/job", headers={"Host": "evil.example:80"})[0], 403)

    def test_post_needs_json_and_our_origin(self):
        self.assertEqual(self.call("/manage/api/install", {"family": "qwen"}, {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.call("/manage/api/install", {"family": "qwen"}, {"Content-Type": "application/json",
                                                                         "Origin": "http://evil.example"})[0], 403)

    def test_install_checks_its_input(self):
        code, body = self.call("/manage/api/install", {"family": "qwen", "model": "Q9_9", "source": "auto"},
                               {"Content-Type": "application/json"})
        self.assertEqual(code, 400)
        code, body = self.call("/manage/api/install", {"family": "swift", "model": "Q2_0", "source": "auto"},
                               {"Content-Type": "application/json"})
        self.assertEqual(code, 400)                                        # not a size of that family
        code, body = self.call("/manage/api/install", {"family": "qwen", "model": "Q2_0", "source": "ftp"},
                               {"Content-Type": "application/json"})
        self.assertEqual(code, 400)


if __name__ == "__main__":
    unittest.main()
