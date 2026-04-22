import os
import tempfile


repo_temp = os.environ.get("CODEX_IOT_REPO_TEMP")

if repo_temp:
    os.makedirs(repo_temp, exist_ok=True)
    tempfile.tempdir = repo_temp
