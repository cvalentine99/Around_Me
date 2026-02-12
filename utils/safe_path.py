"""Path traversal prevention utilities.

Every file operation that accepts user-controlled input (filenames, paths)
MUST use ``resolve_safe`` or ``is_safe_filename`` before touching the filesystem.
"""

from __future__ import annotations

import re
from pathlib import Path


def resolve_safe(user_input: str | Path, allowed_root: str | Path) -> Path:
    """Resolve *user_input* and verify it stays inside *allowed_root*.

    Raises ``ValueError`` if the resolved path escapes the allowed root
    (e.g. via ``../`` traversal or symlink tricks).
    """
    root = Path(allowed_root).resolve()
    target = (root / Path(user_input)).resolve()

    if target == root or root in target.parents:
        return target

    raise ValueError(
        f"Path traversal blocked: {user_input!r} resolves outside {root}"
    )


def is_safe_filename(filename: str, allowed_extensions: tuple[str, ...] | None = None) -> bool:
    """Return True if *filename* is a simple, non-traversal name.

    Rules:
    - No path separators (``/``, ``\\``)
    - No ``..`` components
    - Only alphanumeric, hyphen, underscore, and dot characters
    - Optionally must end with one of *allowed_extensions*
    """
    if not filename:
        return False
    if '/' in filename or '\\' in filename or '..' in filename:
        return False
    if not re.match(r'^[\w\-\.]+$', filename):
        return False
    if allowed_extensions and not filename.lower().endswith(allowed_extensions):
        return False
    return True
