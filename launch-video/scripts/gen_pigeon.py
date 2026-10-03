"""Compatibility entry point for the approved Pidgy film derivatives."""
from pathlib import Path
import subprocess
subprocess.run(['node', str(Path(__file__).with_suffix('.mjs'))], check=True)
