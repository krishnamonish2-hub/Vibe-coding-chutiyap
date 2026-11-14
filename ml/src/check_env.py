"""Phase 1 environment check.

Run from the ml/ folder:
    .\\venv\\Scripts\\python.exe src\\check_env.py

It confirms that we are inside the project's virtual environment and that every
package in requirements.txt can be imported. It does not create data or models.
"""

import importlib
import sys
from pathlib import Path

# requirements.txt name -> Python import name (they differ for scikit-learn)
PACKAGES = {
    "pandas": "pandas",
    "numpy": "numpy",
    "matplotlib": "matplotlib",
    "seaborn": "seaborn",
    "scikit-learn": "sklearn",
    "xgboost": "xgboost",
    "joblib": "joblib",
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
    "pydantic": "pydantic",
}

ML_ROOT = Path(__file__).resolve().parents[1]
EXPECTED_DIRS = ["api", "config", "data/raw", "data/processed", "models",
                 "notebooks", "src", "docs", "reports/figures"]


def main() -> int:
    ok = True
    in_venv = sys.prefix != sys.base_prefix
    print(f"Python      : {sys.version.split()[0]}")
    print(f"Interpreter : {sys.executable}")
    print(f"In venv     : {in_venv}")
    ok &= in_venv

    print("\nPackages:")
    for pip_name, import_name in PACKAGES.items():
        try:
            module = importlib.import_module(import_name)
            print(f"  OK   {pip_name:<13} {getattr(module, '__version__', '?')}")
        except Exception as exc:  # report every failure, don't stop at the first
            print(f"  FAIL {pip_name:<13} {type(exc).__name__}: {exc}")
            ok = False

    print("\nFolders:")
    for rel in EXPECTED_DIRS:
        exists = (ML_ROOT / rel).is_dir()
        print(f"  {'OK  ' if exists else 'MISS'} {rel}/")
        ok &= exists

    print("\nRESULT:", "ALL CHECKS PASSED" if ok else "SOME CHECKS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
