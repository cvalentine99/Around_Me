#!/usr/bin/env bash
# =============================================================================
# installer/lib/checks.sh — Preflight check library for VALENTINE RF
# =============================================================================
# Sourced by install.sh. Never executed directly.
#
# Provides:
#   - System detection (OS, arch, Python, Jetson environment)
#   - Package presence checks (apt, pip, CLI tools)
#   - Structured error reporting (what failed, why, how to fix)
# =============================================================================

# Guard: prevent direct execution
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "ERROR: This file must be sourced, not executed."
    echo "Usage: source installer/lib/checks.sh"
    exit 1
fi

# =============================================================================
# SECTION 1 — Output helpers
# =============================================================================
readonly _RED='\033[0;31m'
readonly _GREEN='\033[0;32m'
readonly _YELLOW='\033[1;33m'
readonly _BLUE='\033[0;34m'
readonly _BOLD='\033[1m'
readonly _NC='\033[0m'

info()    { echo -e "${_BLUE}[INFO]${_NC}  $*"; }
ok()      { echo -e "${_GREEN}[  OK]${_NC}  $*"; }
warn()    { echo -e "${_YELLOW}[WARN]${_NC}  $*"; }
fail()    { echo -e "${_RED}[FAIL]${_NC}  $*"; }
header()  { echo -e "\n${_BOLD}── $* ──${_NC}"; }

# die: Fatal error with structured diagnostics.
#   $1 — what failed
#   $2 — why it matters
#   $3 — how to fix it
die() {
    echo
    fail "FATAL: $1"
    [[ -n "${2:-}" ]] && echo -e "  ${_YELLOW}Why:${_NC}  $2"
    [[ -n "${3:-}" ]] && echo -e "  ${_GREEN}Fix:${_NC}  $3"
    echo
    exit 1
}

# warn_issue: Non-fatal issue with structured diagnostics.
#   $1 — what happened
#   $2 — why it matters
#   $3 — how to fix it
warn_issue() {
    warn "$1"
    [[ -n "${2:-}" ]] && echo -e "    ${_YELLOW}Why:${_NC}  $2"
    [[ -n "${3:-}" ]] && echo -e "    ${_GREEN}Fix:${_NC}  $3"
}

# =============================================================================
# SECTION 2 — System detection
# =============================================================================

# Detect OS and distribution. Sets: DETECTED_OS, DETECTED_DISTRO, DETECTED_CODENAME
detect_os() {
    DETECTED_OS="unknown"
    DETECTED_DISTRO="unknown"
    DETECTED_CODENAME="unknown"

    if [[ ! -f /etc/os-release ]]; then
        die "Cannot detect operating system" \
            "/etc/os-release is missing — this is not a standard Linux distribution" \
            "This installer requires Ubuntu (Jetson L4T). Ensure you are running JetPack OS."
    fi

    # shellcheck disable=SC1091
    source /etc/os-release

    DETECTED_OS="${ID:-unknown}"
    DETECTED_DISTRO="${ID_LIKE:-${ID:-unknown}}"
    DETECTED_CODENAME="${VERSION_CODENAME:-unknown}"

    # Accept ubuntu or debian-based
    case "${DETECTED_OS}" in
        ubuntu|debian)
            ok "OS detected: ${PRETTY_NAME:-${DETECTED_OS}}"
            ;;
        *)
            if [[ "${DETECTED_DISTRO}" == *"ubuntu"* ]] || [[ "${DETECTED_DISTRO}" == *"debian"* ]]; then
                ok "OS detected: ${PRETTY_NAME:-${DETECTED_OS}} (debian-based)"
            else
                die "Unsupported operating system: ${DETECTED_OS}" \
                    "This installer targets Ubuntu on NVIDIA Jetson (L4T)" \
                    "Flash your Jetson with JetPack SDK from https://developer.nvidia.com/jetpack-sdk"
            fi
            ;;
    esac
}

# Detect CPU architecture. Sets: DETECTED_ARCH
detect_arch() {
    DETECTED_ARCH="$(uname -m)"

    case "${DETECTED_ARCH}" in
        aarch64|arm64)
            ok "Architecture: ${DETECTED_ARCH}"
            ;;
        x86_64|amd64)
            warn "Architecture: ${DETECTED_ARCH} — this installer is optimized for aarch64 (Jetson)"
            warn "Proceeding, but some Jetson-specific checks will be skipped."
            ;;
        *)
            die "Unsupported architecture: ${DETECTED_ARCH}" \
                "VALENTINE RF requires aarch64 (Jetson) or x86_64" \
                "Ensure you are running on a supported platform"
            ;;
    esac
}

# Detect NVIDIA Jetson environment. Sets: IS_JETSON, JETSON_L4T_VERSION, JETSON_MODEL
detect_jetson() {
    IS_JETSON=false
    JETSON_L4T_VERSION="unknown"
    JETSON_MODEL="unknown"

    # Method 1: Check for tegra kernel
    if uname -r 2>/dev/null | grep -qi "tegra"; then
        IS_JETSON=true
    fi

    # Method 2: Check for L4T version file
    if [[ -f /etc/nv_tegra_release ]]; then
        IS_JETSON=true
        JETSON_L4T_VERSION=$(head -1 /etc/nv_tegra_release 2>/dev/null | sed 's/.*R\([0-9]*\).*/\1/' || echo "unknown")
    fi

    # Method 3: Check for JetPack-specific paths
    if [[ -d /usr/local/cuda ]] && [[ -f /etc/nv_tegra_release || -d /usr/lib/aarch64-linux-gnu/tegra ]]; then
        IS_JETSON=true
    fi

    # Method 4: Check device-tree model
    if [[ -f /proc/device-tree/model ]]; then
        local model
        model=$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo "")
        if [[ "${model}" == *"Jetson"* ]] || [[ "${model}" == *"NVIDIA"* ]]; then
            IS_JETSON=true
            JETSON_MODEL="${model}"
        fi
    fi

    # Method 5: Check for nvidia-l4t-core package
    if dpkg -l nvidia-l4t-core 2>/dev/null | grep -q "^ii"; then
        IS_JETSON=true
        local pkg_ver
        pkg_ver=$(dpkg-query -W -f='${Version}' nvidia-l4t-core 2>/dev/null || echo "unknown")
        JETSON_L4T_VERSION="${pkg_ver}"
    fi

    if $IS_JETSON; then
        ok "NVIDIA Jetson detected"
        [[ "${JETSON_MODEL}" != "unknown" ]] && info "  Model: ${JETSON_MODEL}"
        [[ "${JETSON_L4T_VERSION}" != "unknown" ]] && info "  L4T version: ${JETSON_L4T_VERSION}"
    else
        if [[ "${DETECTED_ARCH}" == "aarch64" ]]; then
            warn "aarch64 system detected but does not appear to be a Jetson"
            warn "Jetson-specific checks will be skipped; install will continue"
        fi
    fi
}

# Verify Jetson safety constraints. No CUDA installs, no DKMS, no kernel modules.
check_jetson_safety() {
    if ! $IS_JETSON; then
        return 0
    fi

    header "Jetson Safety Checks"

    # Verify CUDA is present (JetPack-provided)
    if [[ -d /usr/local/cuda ]]; then
        local cuda_ver
        cuda_ver=$(cat /usr/local/cuda/version.txt 2>/dev/null || nvcc --version 2>/dev/null | grep "release" | sed 's/.*release //' | sed 's/,.*//' || echo "detected")
        ok "JetPack CUDA present: ${cuda_ver}"
        info "  (This installer will NOT modify CUDA — JetPack manages it)"
    else
        info "CUDA not found at /usr/local/cuda — not required for VALENTINE RF"
    fi

    # Verify cuDNN
    if ldconfig -p 2>/dev/null | grep -q libcudnn; then
        ok "JetPack cuDNN present"
    fi

    # Warn about DKMS
    info "This installer will NOT install any DKMS modules or kernel drivers"
    info "This installer will NOT modify CUDA, cuDNN, or TensorRT"
}

# =============================================================================
# SECTION 3 — Python detection
# =============================================================================

# Detect Python. Sets: PYTHON_BIN, PYTHON_VERSION, PYTHON_MAJOR, PYTHON_MINOR
detect_python() {
    PYTHON_BIN=""
    PYTHON_VERSION=""
    PYTHON_MAJOR=""
    PYTHON_MINOR=""

    # Try python3 first, then python
    for candidate in python3 python; do
        if command -v "${candidate}" >/dev/null 2>&1; then
            PYTHON_BIN="${candidate}"
            break
        fi
    done

    if [[ -z "${PYTHON_BIN}" ]]; then
        die "Python 3 not found" \
            "VALENTINE RF requires Python >= 3.9 to run" \
            "Install with: sudo apt-get install python3 python3-venv python3-pip"
    fi

    # Extract version
    PYTHON_VERSION=$("${PYTHON_BIN}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")')
    PYTHON_MAJOR=$("${PYTHON_BIN}" -c 'import sys; print(sys.version_info.major)')
    PYTHON_MINOR=$("${PYTHON_BIN}" -c 'import sys; print(sys.version_info.minor)')

    if [[ "${PYTHON_MAJOR}" -ne 3 ]] || [[ "${PYTHON_MINOR}" -lt 9 ]]; then
        die "Python ${PYTHON_VERSION} is too old" \
            "VALENTINE RF requires Python >= 3.9 (found ${PYTHON_VERSION})" \
            "Install a newer Python: sudo apt-get install python3.11 python3.11-venv"
    fi

    ok "Python ${PYTHON_VERSION} (${PYTHON_BIN})"

    # Verify venv module is available
    if ! "${PYTHON_BIN}" -m venv --help >/dev/null 2>&1; then
        die "Python venv module is not installed" \
            "Cannot create an isolated virtual environment without it" \
            "Install with: sudo apt-get install python3-venv python3.${PYTHON_MINOR}-venv"
    fi

    ok "Python venv module available"
}

# =============================================================================
# SECTION 4 — Package & tool presence checks
# =============================================================================

# Check if a Debian package is installed.
#   Returns 0 if installed, 1 otherwise.
is_apt_pkg_installed() {
    local pkg="$1"
    dpkg-query -W -f='${Status}' "${pkg}" 2>/dev/null | grep -q "install ok installed"
}

# Check if a command is on PATH or in common sbin locations.
cmd_exists() {
    local c="$1"
    command -v "$c" >/dev/null 2>&1 && return 0
    for dir in /usr/sbin /sbin /usr/local/sbin /usr/local/bin; do
        [[ -x "${dir}/${c}" ]] && return 0
    done
    return 1
}

# Check if any of the given commands exist.
have_any() {
    local c
    for c in "$@"; do
        cmd_exists "$c" && return 0
    done
    return 1
}

# Check a required tool — records failures for final report.
# Usage: check_tool_required "label" "description" cmd1 [cmd2 ...]
MISSING_REQUIRED=()
MISSING_OPTIONAL=()
FOUND_TOOLS=()

check_tool_required() {
    local label="$1"; shift
    local desc="$1"; shift

    if have_any "$@"; then
        ok "${label} — ${desc}"
        FOUND_TOOLS+=("${label}")
    else
        warn "${label} — ${desc} [MISSING]"
        MISSING_REQUIRED+=("${label}|${desc}")
    fi
}

check_tool_optional() {
    local label="$1"; shift
    local desc="$1"; shift

    if have_any "$@"; then
        ok "${label} — ${desc}"
        FOUND_TOOLS+=("${label}")
    else
        info "${label} — ${desc} [not installed, optional]"
        MISSING_OPTIONAL+=("${label}|${desc}")
    fi
}

# =============================================================================
# SECTION 5 — Sudo detection
# =============================================================================

# Detect sudo. Sets: SUDO
detect_sudo() {
    if [[ "$(id -u)" -eq 0 ]]; then
        SUDO=""
        ok "Running as root"
    elif command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
        # Verify sudo works
        if ! sudo -n true 2>/dev/null; then
            info "sudo access required — you may be prompted for your password"
            if ! sudo true; then
                die "sudo authentication failed" \
                    "This installer needs sudo to install system packages" \
                    "Run: sudo -v  (to cache credentials) then re-run this installer"
            fi
        fi
        ok "sudo access confirmed"
    else
        die "Neither root nor sudo available" \
            "System packages (apt) require root privileges to install" \
            "Run as root or install sudo: su -c 'apt-get install sudo'"
    fi
}

# =============================================================================
# SECTION 6 — Disk & resource checks
# =============================================================================

check_disk_space() {
    local target_dir="${1:-.}"
    local min_mb="${2:-500}"

    local avail_kb
    avail_kb=$(df -P -k "${target_dir}" 2>/dev/null | awk 'NR==2 {print $4}')

    if [[ -z "${avail_kb}" ]]; then
        warn "Could not determine available disk space for ${target_dir}"
        return 0
    fi

    local avail_mb=$((avail_kb / 1024))
    if [[ ${avail_mb} -lt ${min_mb} ]]; then
        die "Insufficient disk space: ${avail_mb}MB available, ${min_mb}MB required" \
            "Python venv and compiled tools need at least ${min_mb}MB" \
            "Free up disk space or specify a different installation directory"
    fi

    ok "Disk space: ${avail_mb}MB available (need ${min_mb}MB)"
}

check_memory() {
    local min_mb="${1:-512}"

    if [[ ! -f /proc/meminfo ]]; then
        warn "Cannot check memory — /proc/meminfo not found"
        return 0
    fi

    local total_kb
    total_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)

    if [[ -z "${total_kb}" ]] || ! [[ "${total_kb}" =~ ^[0-9]+$ ]]; then
        warn "Cannot parse memory from /proc/meminfo"
        return 0
    fi

    local total_mb=$((total_kb / 1024))

    if [[ ${total_mb} -lt ${min_mb} ]]; then
        warn_issue "Low memory: ${total_mb}MB detected" \
            "Building native Python packages (numpy, scipy) may fail with < ${min_mb}MB" \
            "Consider using swap: sudo fallocate -l 4G /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
    else
        ok "Memory: ${total_mb}MB total"
    fi
}

# =============================================================================
# SECTION 7 — Final report generator
# =============================================================================

print_tool_report() {
    echo
    header "Tool Availability Summary"

    if [[ ${#FOUND_TOOLS[@]} -gt 0 ]]; then
        ok "${#FOUND_TOOLS[@]} tools found"
    fi

    if [[ ${#MISSING_REQUIRED[@]} -gt 0 ]]; then
        echo
        fail "${#MISSING_REQUIRED[@]} REQUIRED tool(s) missing:"
        local entry
        for entry in "${MISSING_REQUIRED[@]}"; do
            local label="${entry%%|*}"
            local desc="${entry##*|}"
            echo -e "    ${_RED}✗${_NC} ${label} — ${desc}"
        done
    fi

    if [[ ${#MISSING_OPTIONAL[@]} -gt 0 ]]; then
        echo
        warn "${#MISSING_OPTIONAL[@]} optional tool(s) not installed (features will be limited):"
        local entry
        for entry in "${MISSING_OPTIONAL[@]}"; do
            local label="${entry%%|*}"
            local desc="${entry##*|}"
            echo -e "    ${_YELLOW}○${_NC} ${label} — ${desc}"
        done
    fi
}
