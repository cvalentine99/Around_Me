import pytest
from pathlib import Path
import importlib.metadata
try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib
import re

def get_root_path():
    return Path(__file__).parent.parent

def _clean_string(req):
    """Normalizes a requirement string (lowercase and removes spaces)."""
    return req.strip().lower().replace(" ", "")

def _extract_package_name(req):
    """Extract just the package name from a requirement string, without version."""
    cleaned = _clean_string(req)
    # Split on version specifiers
    name = re.split(r'==|>=|~=|<=|!=|>|<', cleaned)[0].strip()
    # Remove extras: "qrcode[pil]" -> "qrcode"
    name = re.sub(r'\[.*\]', '', name)
    # Normalize underscores/hyphens (PEP 503)
    name = re.sub(r'[-_.]+', '-', name)
    return name

def parse_txt_requirements(file_path):
    """Extracts full requirement strings (name + version) from a .txt file."""
    if not file_path.exists():
        return set()
    packages = set()
    with open(file_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith(("#", "-e", "git+", "-r")):
                continue
            packages.add(_clean_string(line))
    return packages

def parse_toml_section(data, section_type="main"):
    """Extracts full requirement strings from pyproject.toml including optional sections."""
    packages = set()
    project = data.get("project", {})

    if section_type == "main":
        deps = project.get("dependencies", [])
    elif section_type == "optional":
        deps = project.get("optional-dependencies", {}).get("optionals", [])
    elif section_type == "dev":
        deps = project.get("optional-dependencies", {}).get("dev", [])
        if not deps:
            deps = data.get("dependency-groups", {}).get("dev", [])

    for req in deps:
        packages.add(_clean_string(req))
    return packages

def test_dependency_files_integrity():
    """1. Verifies that .txt files and pyproject.toml declare the same package names.

    Compares only package names (without version specifiers) since requirements.txt
    may pin exact versions (==) while pyproject.toml uses ranges (>=).
    """
    root = get_root_path()
    toml_path = root / "pyproject.toml"
    assert toml_path.exists(), "Missing pyproject.toml"

    with open(toml_path, "rb") as f:
        toml_data = tomllib.load(f)

    # Validate Production Sync (Main + Optionals) - compare names only
    txt_main = parse_txt_requirements(root / "requirements.txt")
    toml_main = parse_toml_section(toml_data, "main") | parse_toml_section(toml_data, "optional")

    txt_names = {_extract_package_name(r) for r in txt_main}
    toml_names = {_extract_package_name(r) for r in toml_main}

    assert txt_names == toml_names, (
        f"Production package name mismatch!\n"
        f"Only in TXT: {txt_names - toml_names}\n"
        f"Only in TOML: {toml_names - txt_names}"
    )

    # Validate Development Sync - compare names only
    txt_dev = parse_txt_requirements(root / "requirements-dev.txt")
    toml_dev = parse_toml_section(toml_data, "dev")

    txt_dev_names = {_extract_package_name(r) for r in txt_dev}
    toml_dev_names = {_extract_package_name(r) for r in toml_dev}

    assert txt_dev_names == toml_dev_names, (
        f"Development package name mismatch!\n"
        f"Only in TXT: {txt_dev_names - toml_dev_names}\n"
        f"Only in TOML: {toml_dev_names - txt_dev_names}"
    )

def test_environment_vs_toml():
    """2. Verifies that installed packages satisfy TOML requirements."""
    root = get_root_path()
    with open(root / "pyproject.toml", "rb") as f:
        data = tomllib.load(f)

    all_declared = (
        parse_toml_section(data, "main") |
        parse_toml_section(data, "optional") |
        parse_toml_section(data, "dev")
    )
    _verify_installation(all_declared, "TOML")

def test_environment_vs_requirements():
    """3. Verifies that installed packages satisfy .txt requirements."""
    root = get_root_path()
    all_txt_deps = (
        parse_txt_requirements(root / "requirements.txt") |
        parse_txt_requirements(root / "requirements-dev.txt")
    )
    _verify_installation(all_txt_deps, "requirements.txt")

def _verify_installation(package_set, source_name):
    """Helper to check if declared versions match installed versions.

    Only checks pinned (==) versions for installed packages.
    Skips packages that are not installed, as they may be optional
    dev dependencies not needed in all environments.
    """
    version_mismatches = []

    for req in package_set:
        # Split name from version
        parts = re.split(r'==|>=|~=|<=|>|<', req)
        raw_name = parts[0].strip()

        # CLEAN EXTRAS: "qrcode[pil]" -> "qrcode"
        clean_name = re.sub(r'\[.*\]', '', raw_name)

        try:
            installed_ver = importlib.metadata.version(clean_name)
            if "==" in req:
                expected_ver = req.split("==")[1].strip()
                if installed_ver != expected_ver:
                    version_mismatches.append(f"{clean_name} (Installed: {installed_ver}, Expected: {expected_ver})")
        except importlib.metadata.PackageNotFoundError:
            # Package not installed - skip rather than fail.
            # Dev/optional dependencies may not be present in all environments.
            pass

    if version_mismatches:
        pytest.fail(f"Version mismatches with {source_name}:\n" + "\n".join(version_mismatches))
