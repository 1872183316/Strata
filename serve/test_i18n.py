"""The web app's languages (serve/web/i18n.js): every English text the pages show has a Simplified Chinese entry.

The keys are the English texts: t("...") calls and the tables the scripts translate (labels, badges, states), and the
HTML's data-i18n elements and data-i18n-attr attributes.  Run: python -m unittest serve.test_i18n
"""
from __future__ import annotations

import html.parser
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parent / "web"


def dictionary(lang: str) -> dict:
    """The STRINGS[lang] object of i18n.js, read with node when it is there, else with a small JS-literal reader."""
    src = (WEB / "i18n.js").read_text(encoding="utf-8")
    if shutil.which("node"):
        code = src + f"\nprocess.stdout.write(JSON.stringify(STRINGS[{json.dumps(lang)}]));"
        out = subprocess.run(["node", "-"], input=code, capture_output=True, text=True, encoding="utf-8", check=True)
        return json.loads(out.stdout)
    body = src[src.index(f'{json.dumps(lang)}: {{') + len(json.dumps(lang)) + 3:]
    pairs = re.findall(r'"((?:[^"\\]|\\.)*)"\s*:\s*\n?\s*"((?:[^"\\]|\\.)*)"', body)
    return {json.loads(f'"{k}"'): json.loads(f'"{v}"') for k, v in pairs}


def js_keys(name: str) -> set[str]:
    """t("literal") and t('literal') calls, plus the English values of the tables the script passes to t()."""
    src = (WEB / name).read_text(encoding="utf-8")
    keys = {json.loads(f'"{m}"') for m in re.findall(r'\bt\("((?:[^"\\]|\\.)*)"', src)}
    # t(cond ? "a" : "b") and t(x ? "a" : y ? "b" : "c"): the literals after the first "?" of the call's first argument
    # (a literal in the condition, like r.error === "no_gguf", is not shown)
    for m in re.finditer(r'\bt\(([^()]*?\?[^()]*?)(?:,\s*\{|\))', src):
        branches = m.group(1).split("?", 1)[1]
        for lit in re.finditer(r'"((?:[^"\\]|\\.)*)"', branches):
            if not re.search(r"[=!]==?\s*$", branches[:lit.start()]):
                keys.add(json.loads(f'"{lit.group(1)}"'))
    return keys


TABLES = {   # app.js texts that reach t() through a variable
    "METRICS labels": ["Speed", "GPU load", "VRAM", "GPU temp", "Power", "PCIe", "CPU", "Disk read"],
    "request badges": ["Done", "Max tokens|finish", "Stopped", "Closed", "Error"],
    "MCP states": ["Connected", "Starting", "Failed", "Stopped", "Waiting"],
    "tool states": ["Writing", "Running", "Done", "Error", "Not run"],
    "thinking help": ["answers right away", "short", "medium", "thorough (default)"],
    "chat list groups": ["Today", "Yesterday", "Previous 7 days", "Older"],
    "server phases": ["Thinking", "Answering", "Tool call complete"],
    "KV kinds": ["8-bit", "4-bit (Hadamard-rotated)", "16-bit"],
    "projection": ["experimental speed projection on", "experimental speed projection off"],
}


SETUP_TABLES = [   # setup.js texts that reach t() through a variable
    "Runs well", "Runs, slower", "Will not run", "Strata runs it", "May run (not tested)", "Not tested", "Strata cannot run it",
    "Q1 class", "Q2 class", "Q3 class", "Q4 class", "Q5 class", "Q6 class", "Q8 class", "16-bit", "32-bit",
    "Routed experts", "Shared experts", "Router", "Norms", "Hyper-connections", "N-gram / per-layer embeddings",
    "Linear attention / SSM", "Attention (incl. GDN qkv/gate)", "Dense FFN", "Token embedding", "Output head", "MTP / nextn", "Other",
]


class Keys(html.parser.HTMLParser):
    """data-i18n texts and data-i18n-attr values of a page."""

    def __init__(self):
        super().__init__()
        self.keys, self.stack = set(), []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for name in (a.get("data-i18n-attr") or "").split(","):
            if name and a.get(name):
                self.keys.add(" ".join(a[name].split()))
        if tag in ("br", "img", "input", "meta", "link", "use"):
            return
        self.stack.append([tag, "data-i18n" in a, ""])

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def handle_data(self, data):
        for item in self.stack:
            item[2] += data

    def handle_endtag(self, tag):
        while self.stack:
            t, marked, text = self.stack.pop()
            if marked:
                self.keys.add(" ".join(text.split()))
            if t == tag:
                break


def html_keys(name: str) -> set[str]:
    p = Keys()
    p.feed((WEB / name).read_text(encoding="utf-8").replace("&hellip;", "…"))
    return p.keys


class I18nTest(unittest.TestCase):
    def setUp(self):
        self.zh = dictionary("zh-CN")

    def missing(self, keys):
        return sorted(k for k in keys if k and k not in self.zh)

    def test_index_page(self):
        self.assertEqual(self.missing(html_keys("index.html")), [])

    def test_app_script(self):
        self.assertEqual(self.missing(js_keys("app.js")), [])

    def test_tables(self):
        for name, keys in TABLES.items():
            with self.subTest(name):
                self.assertEqual(self.missing(keys), [])

    def test_monitor_page(self):
        self.assertEqual(self.missing(html_keys("monitor.html") | js_keys("monitor.js")), [])

    def test_model_manager_page(self):
        keys = html_keys("setup.html") | js_keys("setup.js") | set(SETUP_TABLES)
        self.assertEqual(self.missing(keys), [])

    def test_placeholders_match(self):
        """a translation keeps the {names} of its English text"""
        for en, zh in self.zh.items():
            with self.subTest(en):
                self.assertEqual(sorted(re.findall(r"\{(\w+)\}", en)), sorted(re.findall(r"\{(\w+)\}", zh)))

    def test_no_duplicate_keys(self):
        src = (WEB / "i18n.js").read_text(encoding="utf-8")
        body = src[src.index('"zh-CN": {'):]
        keys = re.findall(r'(?:^|[{,]\s*)"((?:[^"\\]|\\.)*)"\s*:', body, re.M)
        dup = sorted({k for k in keys if keys.count(k) > 1})
        self.assertEqual(dup, [])

    def test_pages_load_the_dictionary_first(self):
        page = (WEB / "index.html").read_text(encoding="utf-8")
        self.assertLess(page.index('src="web/i18n.js"'), page.index('src="web/app.js"'))
        mon = (WEB / "monitor.html").read_text(encoding="utf-8")
        self.assertLess(mon.index('src="/web/i18n.js"'), mon.index('src="/web/monitor.js"'))


if __name__ == "__main__":
    unittest.main()
