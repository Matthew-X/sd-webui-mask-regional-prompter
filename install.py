"""Mask Regional Prompter Installation Script.

Automatically installs required packages on extension load.
"""

from __future__ import annotations

import subprocess
import sys
from typing import Sequence


def install_requirements(packages: Sequence[str] | None = None) -> None:
    """Install required packages for the extension if not already present."""
    if packages is None:
        packages = ["opencv-python", "einops", "torchvision"]

    for package in packages:
        module_name = package.replace("-", "_").split("==")[0]
        try:
            __import__(module_name)
        except ImportError:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", package, "-q"]
            )


install_requirements()
