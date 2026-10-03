"""Compatibility entry point for the approved compact Pidgy packer."""
from pathlib import Path
import subprocess
subprocess.run(['node', str(Path(__file__).with_suffix('.mjs'))], check=True)
