"""The fork's engine build on GitHub Actions (.github/workflows/oldhw-engine.yml): its two steps outside CMake.

    python tools/ci_package.py llama
        llama.cpp at setup.py's pinned commit (LLAMA_CPP_COMMIT) into third_party/llama.cpp, as setup.py unpacks it
        (without tools/ui, whose deep paths pass Windows' 260-character limit).
    python tools/ci_package.py zip --exe build/strata.exe --vision build-vision/bin/strata-vision.exe --out X.zip
        the release archive setup.py downloads (get_prebuilt): the engine, the image encoder and BUILD.json, whose
        version, archs, ptx and cuda setup checks before it uses the engine.
    python tools/ci_package.py modelscope dist/*.zip
        a copy of the release archives on ModelScope (www.modelscope.cn), which mainland China reaches when GitHub's
        downloads do not: the model repository MODELSCOPE_REPO (setup.py's MS_ENGINE_REPO), each archive at
        oldhw-v<version>/<name>, with the token MODELSCOPE_TOKEN (a write token from modelscope.cn/my/myaccesstoken).
        Without the token it says so and does nothing (forks without it still build).
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def pinned_commit() -> str:
    """setup.py's LLAMA_CPP_COMMIT, read from the file (importing setup.py is not needed for one string)."""
    m = re.search(r'^LLAMA_CPP_COMMIT = "([0-9a-f]{40})"', (ROOT / "setup.py").read_text(encoding="utf-8"), re.M)
    if not m:
        raise SystemExit("LLAMA_CPP_COMMIT not found in setup.py")
    return m.group(1)


def version() -> str:
    m = re.search(r"project\(strata VERSION ([\d.]+)", (ROOT / "CMakeLists.txt").read_text(encoding="utf-8"))
    return m.group(1)


def llama() -> None:
    commit = pinned_commit()
    dst = ROOT / "third_party" / "llama.cpp"
    url = f"https://github.com/ggml-org/llama.cpp/archive/{commit}.zip"
    print(f"llama.cpp {commit[:7]} <- {url}", flush=True)
    data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "strata-ci"}), timeout=600).read()
    tmp = ROOT / "third_party" / "_unpack"
    shutil.rmtree(tmp, ignore_errors=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extractall(tmp, [m for m in z.namelist() if "/tools/ui/" not in m])
    shutil.rmtree(dst, ignore_errors=True)
    shutil.move(str(next(tmp.iterdir())), str(dst))
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"-> {dst}")


def cuda_version() -> str:
    """nvcc's release (e.g. "13.0"), as BUILD.json's "cuda"."""
    try:
        out = subprocess.run(["nvcc", "--version"], capture_output=True, text=True).stdout
    except OSError:                                     # no nvcc on the PATH: say so instead of guessing
        return "?"
    m = re.search(r"release (\d+\.\d+)", out)
    return m.group(1) if m else "?"


def package(exe: Path, vision: Path | None, out: Path) -> None:
    archs_spec = os.environ.get("CUDA_ARCHS", "")
    archs = sorted({int(re.match(r"\d+", a).group()) for a in archs_spec.split(";") if re.match(r"\d+", a)})
    meta = {"version": version(), "source": "release", "archs": archs,
            # an architecture without "-real" carries its PTX too: newer cards JIT-compile it (setup's "ptx" check)
            "ptx": any(not a.endswith("-real") for a in archs_spec.split(";") if a),
            "cuda": cuda_version(), "vision": "gpu" if vision else "none", "portable": True,
            "fork": "oldhw", "commit": os.environ.get("GITHUB_SHA", "")[:12]}
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(exe, exe.name)
        if vision:
            z.write(vision, vision.name)
        z.writestr("BUILD.json", json.dumps(meta, indent=1))
    print(json.dumps(meta, indent=1))
    print(f"-> {out} ({out.stat().st_size / 1e6:.1f} MB)")


MS_README = """# Strata engine (fork 1872183316/Strata, branch oldhw)

A copy of the ready-made engine archives of https://github.com/1872183316/Strata/releases (release oldhw-v<version>),
for PCs that reach ModelScope but not GitHub's downloads.  setup.py downloads them from here by itself; there is no
need to download them by hand.  Built by GitHub Actions from the fork's sources (STRATA_PORTABLE, CUDA 13.0,
RTX 20/30/40/50); each archive's BUILD.json names the commit.

Strata: https://github.com/Niko1221/Strata (MIT)
"""


def modelscope(files: list[Path]) -> None:
    token = os.environ.get("MODELSCOPE_TOKEN", "").strip()
    repo = os.environ.get("MODELSCOPE_REPO", "").strip()
    if not token or not repo:
        print("MODELSCOPE_TOKEN or MODELSCOPE_REPO is not set: no copy on ModelScope")
        return
    from modelscope_hub.api import HubApi            # pip install modelscope-hub (CI only; setup.py does not need it)
    api = HubApi(token=token)
    api.login(token)
    if not api.repo_exists(repo, "model"):
        api.create_repo(repo, "model", visibility="public", license="mit",
                        description="Ready-made Strata engine (fork 1872183316/Strata, branch oldhw)")
        print(f"created {repo}")
    api.upload_file(repo, "model", MS_README.encode(), "README.md", commit_message="README", disable_tqdm=True)
    tag = f"oldhw-v{version()}"
    sha = os.environ.get("GITHUB_SHA", "")[:7]
    for f in files:
        api.upload_file(repo, "model", str(f), f"{tag}/{f.name}", commit_message=f"{tag} {f.name} ({sha})",
                        disable_tqdm=True)
        print(f"-> {repo}/{tag}/{f.name} ({f.stat().st_size / 1e6:.1f} MB)", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["llama", "zip", "modelscope"])
    ap.add_argument("files", nargs="*", type=Path)
    ap.add_argument("--exe", type=Path)
    ap.add_argument("--vision", type=Path)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()
    if a.step == "llama":
        llama()
    elif a.step == "modelscope":
        modelscope(a.files)
    else:
        if not (a.exe and a.out):
            ap.error("zip needs --exe and --out")
        package(a.exe, a.vision, a.out)


if __name__ == "__main__":
    main()
