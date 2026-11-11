#!/usr/bin/env python3
"""Compatibility shim: the local art server is now tools/asset_server.py (it serves the Gear,
Tileset and Objects makers under /studio/, not just gear). This runs it so older instructions
and `python tools/gear_server.py` keep working."""
import os
import runpy

runpy.run_path(os.path.join(os.path.dirname(os.path.abspath(__file__)), "asset_server.py"),
               run_name="__main__")
