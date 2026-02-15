#!/usr/bin/env bash
# ==============================================================================
# VALENTINE RF — Installer Helper Library
# ==============================================================================
#
# Reusable functions for system detection, validation, and dependency checks.
# Designed for NVIDIA Jetson (aarch64/L4T) but works on any Debian/Ubuntu.
#
# Sourced by install.sh — not executable on its own.
# ==============================================================================

# Guard against direct execution
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "ERROR: This script is a library. Source it from install.sh, do not run directly."
    exit 1
fi

# ==============================================================================
# Output helpers
# ==============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()      { echo -e "${GREEN}[  OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()    { echo -e "${RED}[FAIL]${NC} $*"; }
section() { echo -e "\n${CYAN}${BOLD}── $* ──${NC}"; }
detail()  { echo -e "       $*"; }

# ==============================================================================
# Progress bar
# ==============================================================================
INSTALLER_CURRENT_STEP=0
INSTALLER_TOTAL_STEPS=0

progress() {
    local msg="$1"
    ((INSTALLER_CURRENT_STEP++)) || true
    if [[ "$INSTALLER_TOTAL_STEPS" -gt 0 ]]; then
        local pct=$((INSTALLER_CURRENT_STEP * 100 / INSTALLER_TOTAL_STEPS))
        local filled=$((pct / 5))
        local empty=$((20 - filled))
        local bar=""
        local i
        for ((i = 0; i < filled; i++)); do bar+="█"; done
        for ((i = 0; i < empty; i++)); do bar+="░"; done
        echo -e "${BLUE}[${INSTALLER_CURRENT_STEP}/${INSTALLER_TOTAL_STEPS}]${NC} ${bar} ${pct}% — ${msg}"
    else
        echo -e "${BLUE}[*]${NC} ${msg}"
    fi
}

# ==============================================================================
# Core utilities
# ==============================================================================

# Check if a command exists on PATH or in common sbin dirs
cmd_exists() {
    local c="$1"
    command -v "$c" >/dev/null 2>&1 && return 0
    for d in /usr/sbin /sbin /usr/local/sbin /usr/local/bin; do
        [[ -x "${d}/${c}" ]] && return 0
    done
    return 1
}

# Check if any of the listed commands exist
have_any() {
    local c
    for c in "$@"; do
        cmd_exists "$c" && return 0
    done
    return 1
}

# Resolve sudo: sets SUDO variable
resolve_sudo() {
    if [[ "$(id -u)" -eq 0 ]]; then
        SUDO=""
        ok "Running as root"
    elif cmd_exists sudo; then
        SUDO="sudo"
        # Verify sudo works
        if ! $SUDO true 2>/dev/null; then
            fail "sudo exists but could not authenticate."
            detail "Run: sudo -v   (to cache credentials)"
            detail "Or run this installer as root."
            return 1
        fi
        ok "sudo access verified"
    else
        fail "Not running as root and sudo is not installed."
        detail "WHAT FAILED: Privilege escalation check"
        detail "WHY IT MATTERS: System packages require root to install"
        detail "HOW TO FIX: Install sudo (apt install sudo) or run as root"
        return 1
    fi
}

# Interactive prompt with non-interactive default
ask_yes_no() {
    local prompt="$1"
    local default="${2:-n}"

    if [[ "${NON_INTERACTIVE:-false}" == "true" ]]; then
        info "Non-interactive mode: defaulting to '${default}' for: ${prompt}"
        [[ "$default" == "y" ]]
        return
    fi
    if [[ ! -t 0 ]]; then
        warn "No TTY available, defaulting to '${default}' for: ${prompt}"
        [[ "$default" == "y" ]]
        return
    fi
    if [[ "$default" == "y" ]]; then
        read -r -p "  $prompt [Y/n]: " response
        [[ -z "$response" || "$response" =~ ^[Yy] ]]
    else
        read -r -p "  $prompt [y/N]: " response
        [[ "$response" =~ ^[Yy] ]]
    fi
}

# ==============================================================================
# System detection
# ==============================================================================

# Detect OS family. Sets: DETECTED_OS, DETECTED_OS_VERSION, DETECTED_OS_CODENAME
detect_os() {
    DETECTED_OS="unknown"
    DETECTED_OS_VERSION=""
    DETECTED_OS_CODENAME=""

    if [[ ! -f /etc/os-release ]]; then
        fail "Cannot detect OS: /etc/os-release not found."
        detail "WHAT FAILED: OS detection"
        detail "WHY IT MATTERS: Installer needs to know which package manager to use"
        detail "HOW TO FIX: This installer requires Debian or Ubuntu. Verify your OS."
        return 1
    fi

    # shellcheck disable=SC1091
    source /etc/os-release

    case "${ID:-}" in
        ubuntu|debian)
            DETECTED_OS="${ID}"
            DETECTED_OS_VERSION="${VERSION_ID:-unknown}"
            DETECTED_OS_CODENAME="${VERSION_CODENAME:-unknown}"
            ;;
        *)
            # Check ID_LIKE for derivatives
            if [[ "${ID_LIKE:-}" == *"ubuntu"* ]] || [[ "${ID_LIKE:-}" == *"debian"* ]]; then
                DETECTED_OS="${ID}"
                DETECTED_OS_VERSION="${VERSION_ID:-unknown}"
                DETECTED_OS_CODENAME="${VERSION_CODENAME:-unknown}"
            else
                fail "Unsupported OS: ${ID:-unknown} (${PRETTY_NAME:-})"
                detail "WHAT FAILED: OS compatibility check"
                detail "WHY IT MATTERS: This installer is designed for Debian/Ubuntu and derivatives"
                detail "HOW TO FIX: Use Ubuntu 20.04+ or Debian 11+, or install manually"
                return 1
            fi
            ;;
    esac

    ok "OS: ${PRETTY_NAME:-${DETECTED_OS} ${DETECTED_OS_VERSION}}"
}

# Detect architecture. Sets: DETECTED_ARCH
detect_arch() {
    DETECTED_ARCH="$(uname -m)"
    case "$DETECTED_ARCH" in
        aarch64|arm64)
            DETECTED_ARCH="aarch64"
            ok "Architecture: aarch64 (ARM 64-bit)"
            ;;
        x86_64|amd64)
            DETECTED_ARCH="x86_64"
            ok "Architecture: x86_64"
            ;;
        armv7l|armhf)
            DETECTED_ARCH="armv7l"
            warn "Architecture: armv7l (32-bit ARM) — some packages may not have wheels"
            ;;
        *)
            fail "Unsupported architecture: ${DETECTED_ARCH}"
            detail "WHAT FAILED: Architecture detection"
            detail "WHY IT MATTERS: Binary packages and wheels may not exist for this arch"
            detail "HOW TO FIX: Use aarch64 (Jetson/RPi5) or x86_64"
            return 1
            ;;
    esac
}

# Detect NVIDIA Jetson environment. Sets: IS_JETSON, JETSON_L4T_VERSION, JETSON_JETPACK_VERSION
detect_jetson() {
    IS_JETSON=false
    JETSON_L4T_VERSION=""
    JETSON_JETPACK_VERSION=""
    JETSON_BOARD=""

    # Check 1: tegra kernel
    local kernel
    kernel="$(uname -r)"
    local has_tegra=false
    if [[ "$kernel" == *tegra* ]]; then
        has_tegra=true
    fi

    # Check 2: L4T version file
    local has_l4t=false
    if [[ -f /etc/nv_tegra_release ]]; then
        has_l4t=true
        # Parse: # R36 (release), REVISION: 4.3, ...
        local l4t_line
        l4t_line="$(head -1 /etc/nv_tegra_release 2>/dev/null || true)"
        if [[ "$l4t_line" =~ R([0-9]+).*REVISION:\ ([0-9.]+) ]]; then
            JETSON_L4T_VERSION="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
        fi
    fi

    # Check 3: dpkg-query for nvidia-l4t-core
    local has_l4t_pkg=false
    if dpkg -l nvidia-l4t-core >/dev/null 2>&1; then
        has_l4t_pkg=true
        if [[ -z "$JETSON_L4T_VERSION" ]]; then
            JETSON_L4T_VERSION="$(dpkg-query -W -f='${Version}' nvidia-l4t-core 2>/dev/null || true)"
        fi
    fi

    # Check 4: Jetson model from /proc/device-tree/model
    if [[ -f /proc/device-tree/model ]]; then
        JETSON_BOARD="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || true)"
    fi

    # Check 5: JetPack version from apt
    if dpkg -l nvidia-jetpack >/dev/null 2>&1; then
        JETSON_JETPACK_VERSION="$(dpkg-query -W -f='${Version}' nvidia-jetpack 2>/dev/null || true)"
    fi

    # Verdict
    if $has_tegra || $has_l4t || $has_l4t_pkg; then
        IS_JETSON=true
        ok "NVIDIA Jetson detected"
        [[ -n "$JETSON_BOARD" ]] && detail "Board: ${JETSON_BOARD}"
        [[ -n "$JETSON_L4T_VERSION" ]] && detail "L4T version: ${JETSON_L4T_VERSION}"
        [[ -n "$JETSON_JETPACK_VERSION" ]] && detail "JetPack version: ${JETSON_JETPACK_VERSION}"
        detail "Kernel: ${kernel}"

        # Detect CUDA
        if cmd_exists nvcc; then
            local cuda_ver
            cuda_ver="$(nvcc --version 2>/dev/null | grep -oP 'release \K[0-9.]+' || true)"
            ok "CUDA detected: ${cuda_ver:-present} (JetPack-provided, will not modify)"
        elif [[ -d /usr/local/cuda ]]; then
            ok "CUDA directory found at /usr/local/cuda (JetPack-provided, will not modify)"
        fi

        # Detect cuDNN
        if dpkg -l libcudnn* >/dev/null 2>&1; then
            local cudnn_ver
            cudnn_ver="$(dpkg-query -W -f='${Version}' 'libcudnn*' 2>/dev/null | head -1 || true)"
            ok "cuDNN detected: ${cudnn_ver:-present} (JetPack-provided, will not modify)"
        fi
    else
        info "Not an NVIDIA Jetson (standard Linux environment)"
    fi
}

# Detect Python. Sets: PYTHON_BIN, PYTHON_VERSION, PYTHON_MAJOR, PYTHON_MINOR
detect_python() {
    PYTHON_BIN=""
    PYTHON_VERSION=""
    PYTHON_MAJOR=""
    PYTHON_MINOR=""

    # Prefer python3 explicitly
    local candidates=("python3" "python3.12" "python3.11" "python3.10" "python3.9")
    for candidate in "${candidates[@]}"; do
        if cmd_exists "$candidate"; then
            PYTHON_BIN="$(command -v "$candidate")"
            break
        fi
    done

    if [[ -z "$PYTHON_BIN" ]]; then
        fail "Python 3 not found on PATH."
        detail "WHAT FAILED: Python 3 detection"
        detail "WHY IT MATTERS: VALENTINE RF requires Python 3.9+"
        detail "HOW TO FIX: sudo apt install python3 python3-venv python3-pip"
        return 1
    fi

    PYTHON_VERSION="$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")')"
    PYTHON_MAJOR="$("$PYTHON_BIN" -c 'import sys; print(sys.version_info.major)')"
    PYTHON_MINOR="$("$PYTHON_BIN" -c 'import sys; print(sys.version_info.minor)')"

    if [[ "$PYTHON_MAJOR" -lt 3 ]] || { [[ "$PYTHON_MAJOR" -eq 3 ]] && [[ "$PYTHON_MINOR" -lt 9 ]]; }; then
        fail "Python ${PYTHON_VERSION} found, but 3.9+ is required."
        detail "WHAT FAILED: Python version check"
        detail "WHY IT MATTERS: VALENTINE RF uses Python 3.9+ syntax (match/case, type hints)"
        detail "HOW TO FIX: sudo apt install python3.11 python3.11-venv (or newer)"
        return 1
    fi

    ok "Python: ${PYTHON_VERSION} (${PYTHON_BIN})"

    # Warn about system-managed Python (PEP 668)
    if "$PYTHON_BIN" -c "import sys; sys.exit(0 if hasattr(sys, '_base_executable') else 1)" 2>/dev/null; then
        detail "System-managed Python detected — venv isolation is mandatory (PEP 668)"
    fi
}

# Check that python3-venv is available. Sets: VENV_OK
check_venv_available() {
    VENV_OK=false

    if "$PYTHON_BIN" -m venv --help >/dev/null 2>&1; then
        VENV_OK=true
        ok "python3 -m venv is available"
    else
        fail "python3-venv module is not installed."
        detail "WHAT FAILED: venv availability check"
        detail "WHY IT MATTERS: Installer creates a project-local venv/ to avoid polluting system Python"
        detail "HOW TO FIX: sudo apt install python3-venv"
        return 1
    fi
}

# Check pip availability (inside or outside venv)
check_pip_available() {
    local python="${1:-$PYTHON_BIN}"

    if "$python" -m pip --version >/dev/null 2>&1; then
        local pip_ver
        pip_ver="$("$python" -m pip --version 2>/dev/null | awk '{print $2}')"
        ok "pip: ${pip_ver}"
        return 0
    else
        fail "pip is not available for ${python}."
        detail "WHAT FAILED: pip availability"
        detail "WHY IT MATTERS: Python dependencies are installed via pip inside the venv"
        detail "HOW TO FIX: sudo apt install python3-pip"
        return 1
    fi
}

# ==============================================================================
# APT package management
# ==============================================================================

# Check if an apt package is installed
apt_is_installed() {
    dpkg -l "$1" 2>/dev/null | grep -q "^ii"
}

# Install a single apt package only if missing. Returns 0 on success.
apt_install_if_missing() {
    local pkg="$1"
    if apt_is_installed "$pkg"; then
        ok "apt: ${pkg} (already installed)"
        return 0
    fi
    info "apt: installing ${pkg}..."
    if $SUDO apt-get install -y --no-install-recommends "$pkg" 2>&1 | tail -3; then
        ok "apt: ${pkg} installed"
        return 0
    else
        fail "apt: failed to install ${pkg}"
        detail "WHAT FAILED: apt-get install ${pkg}"
        detail "WHY IT MATTERS: This package is needed for VALENTINE RF functionality"
        detail "HOW TO FIX: Run 'sudo apt-get update' then retry, or install manually"
        return 1
    fi
}

# Install multiple apt packages, skipping already-installed ones
apt_install_batch() {
    local to_install=()
    local pkg
    for pkg in "$@"; do
        if ! apt_is_installed "$pkg"; then
            to_install+=("$pkg")
        else
            ok "apt: ${pkg} (already installed)"
        fi
    done

    if [[ ${#to_install[@]} -eq 0 ]]; then
        return 0
    fi

    info "apt: installing ${#to_install[@]} package(s): ${to_install[*]}"
    if $SUDO apt-get install -y --no-install-recommends "${to_install[@]}" 2>&1 | tail -5; then
        ok "apt: batch install complete"
        return 0
    else
        fail "apt: batch install failed for: ${to_install[*]}"
        detail "WHAT FAILED: apt-get install ${to_install[*]}"
        detail "WHY IT MATTERS: Some system dependencies are missing"
        detail "HOW TO FIX: Run 'sudo apt-get update && sudo apt-get install -y ${to_install[*]}'"
        return 1
    fi
}

# Try installing any one of a list of alternative package names
apt_try_any() {
    local pkg
    for pkg in "$@"; do
        if apt_is_installed "$pkg"; then
            ok "apt: ${pkg} (already installed)"
            return 0
        fi
        if $SUDO apt-get install -y --no-install-recommends "$pkg" >/dev/null 2>&1; then
            ok "apt: ${pkg} installed"
            return 0
        fi
    done
    return 1
}

# ==============================================================================
# Port availability
# ==============================================================================

# Check if a TCP port is available (not bound)
check_port_available() {
    local port="$1"
    local label="${2:-service}"

    if cmd_exists ss; then
        if ss -tlnp 2>/dev/null | grep -q ":${port} "; then
            warn "Port ${port} (${label}) is already in use"
            local pid_info
            pid_info="$(ss -tlnp 2>/dev/null | grep ":${port} " | head -1)"
            detail "Bound by: ${pid_info}"
            return 1
        fi
    elif cmd_exists netstat; then
        if netstat -tlnp 2>/dev/null | grep -q ":${port} "; then
            warn "Port ${port} (${label}) is already in use"
            return 1
        fi
    fi
    ok "Port ${port} (${label}) is available"
    return 0
}

# ==============================================================================
# SDR tool detection (read-only — no installation here)
# ==============================================================================

# Track missing tools by category for the final report
declare -a MISSING_REQUIRED=()
declare -a MISSING_OPTIONAL=()
declare -a PRESENT_TOOLS=()

check_tool_required() {
    local label="$1"; shift
    local desc="$1"; shift
    # Remaining args are alternative command names
    if have_any "$@"; then
        PRESENT_TOOLS+=("${label}")
        ok "${label} — ${desc}"
    else
        MISSING_REQUIRED+=("${label}|${desc}|$*")
        warn "${label} — ${desc} [MISSING, required]"
    fi
}

check_tool_optional() {
    local label="$1"; shift
    local desc="$1"; shift
    if have_any "$@"; then
        PRESENT_TOOLS+=("${label}")
        ok "${label} — ${desc}"
    else
        MISSING_OPTIONAL+=("${label}|${desc}|$*")
        warn "${label} — ${desc} [missing, optional]"
    fi
}

# Run a full tool audit. Call after installation to verify.
audit_tools() {
    MISSING_REQUIRED=()
    MISSING_OPTIONAL=()
    PRESENT_TOOLS=()

    section "SDR / RF Tools"
    check_tool_required "rtl_fm"        "RTL-SDR FM demodulator"       rtl_fm
    check_tool_required "rtl_test"      "RTL-SDR device tester"        rtl_test
    check_tool_required "rtl_tcp"       "RTL-SDR TCP server"           rtl_tcp
    check_tool_required "multimon-ng"   "POCSAG/FLEX pager decoder"    multimon-ng
    check_tool_required "rtl_433"       "433 MHz sensor decoder"       rtl_433 rtl433

    section "Aircraft Decoders"
    check_tool_required "dump1090"      "ADS-B 1090 MHz decoder"       dump1090 readsb dump1090-fa
    check_tool_optional "dump978-fa"    "UAT 978 MHz decoder"          dump978-fa dump978
    check_tool_optional "uat2json"      "UAT JSON converter"           uat2json
    check_tool_required "acarsdec"      "ACARS message decoder"        acarsdec

    section "Maritime / Vessel"
    check_tool_required "AIS-catcher"   "AIS vessel decoder"           AIS-catcher aiscatcher

    section "Audio / Media"
    check_tool_required "ffmpeg"        "Audio encoder/decoder"        ffmpeg

    section "WiFi Tools"
    check_tool_required "airmon-ng"     "WiFi monitor mode"            airmon-ng
    check_tool_required "airodump-ng"   "WiFi AP scanner"              airodump-ng
    check_tool_required "aireplay-ng"   "WiFi injection/deauth"        aireplay-ng
    check_tool_optional "hcxdumptool"   "PMKID capture"                hcxdumptool
    check_tool_optional "hcxpcapngtool" "PMKID conversion"             hcxpcapngtool

    section "Bluetooth"
    check_tool_required "bluetoothctl"  "Bluetooth CLI controller"     bluetoothctl
    check_tool_required "hcitool"       "Bluetooth scan utility"       hcitool
    check_tool_required "hciconfig"     "Bluetooth adapter config"     hciconfig

    section "GPS"
    check_tool_optional "gpsd"          "GPS daemon"                   gpsd

    section "APRS"
    check_tool_optional "direwolf"      "APRS TNC modem"               direwolf

    section "Digital Voice"
    check_tool_optional "dsd"           "Digital speech decoder"        dsd dsd-fme

    section "Weather Satellite"
    check_tool_optional "satdump"       "NOAA/Meteor satellite decoder" satdump

    section "Utility Meters"
    check_tool_optional "rtlamr"        "Smart meter decoder"          rtlamr

    section "Multi-SDR"
    check_tool_optional "SoapySDRUtil"  "SoapySDR device utility"      SoapySDRUtil
}

# Print final tool audit summary
print_tool_summary() {
    echo
    section "Tool Audit Summary"
    ok "${#PRESENT_TOOLS[@]} tool(s) present"

    if [[ ${#MISSING_REQUIRED[@]} -gt 0 ]]; then
        fail "${#MISSING_REQUIRED[@]} REQUIRED tool(s) missing:"
        local entry
        for entry in "${MISSING_REQUIRED[@]}"; do
            IFS='|' read -r label desc cmds <<< "$entry"
            detail "  - ${label}: ${desc} (commands tried: ${cmds})"
        done
    fi

    if [[ ${#MISSING_OPTIONAL[@]} -gt 0 ]]; then
        warn "${#MISSING_OPTIONAL[@]} optional tool(s) missing (features will be limited):"
        local entry
        for entry in "${MISSING_OPTIONAL[@]}"; do
            IFS='|' read -r label desc cmds <<< "$entry"
            detail "  - ${label}: ${desc}"
        done
    fi
}

# ==============================================================================
# Python venv validation
# ==============================================================================

# Validate that critical Python imports work inside the venv
validate_python_imports() {
    local python="$1"
    local errors=0

    section "Python Import Validation"

    # Critical imports (app will not start without these)
    local critical_modules=("quart" "werkzeug" "httpx" "quart_rate_limiter")
    for mod in "${critical_modules[@]}"; do
        if "$python" -c "import ${mod}" 2>/dev/null; then
            ok "import ${mod}"
        else
            fail "import ${mod} FAILED — application will not start"
            ((errors++))
        fi
    done

    # Important imports (some features will not work without these)
    local important_modules=("numpy" "scipy" "PIL" "skyfield" "bleak" "serial" "scapy")
    for mod in "${important_modules[@]}"; do
        if "$python" -c "import ${mod}" 2>/dev/null; then
            ok "import ${mod}"
        else
            warn "import ${mod} unavailable — some features will be limited"
        fi
    done

    # Optional imports
    local optional_modules=("meshtastic" "qrcode" "websocket" "psycopg2")
    for mod in "${optional_modules[@]}"; do
        if "$python" -c "import ${mod}" 2>/dev/null; then
            ok "import ${mod}"
        else
            detail "import ${mod} unavailable (optional)"
        fi
    done

    if [[ "$errors" -gt 0 ]]; then
        fail "${errors} critical import(s) failed. The application will not start."
        detail "WHAT FAILED: Python dependency validation"
        detail "WHY IT MATTERS: Missing core packages prevent the web server from starting"
        detail "HOW TO FIX: Activate the venv and run: pip install -r requirements.txt"
        return 1
    fi

    ok "All critical Python imports verified"
    return 0
}

# ==============================================================================
# Disk space check
# ==============================================================================

check_disk_space() {
    local path="${1:-.}"
    local required_mb="${2:-500}"

    local avail_kb
    avail_kb="$(df -k "$path" 2>/dev/null | awk 'NR==2 {print $4}')"
    if [[ -z "$avail_kb" ]]; then
        warn "Could not determine available disk space at ${path}"
        return 0
    fi

    local avail_mb=$((avail_kb / 1024))
    if [[ "$avail_mb" -lt "$required_mb" ]]; then
        fail "Insufficient disk space: ${avail_mb} MB available, ${required_mb} MB required."
        detail "WHAT FAILED: Disk space check at ${path}"
        detail "WHY IT MATTERS: Installation needs space for packages, venv, and build artifacts"
        detail "HOW TO FIX: Free up disk space or install to a larger partition"
        return 1
    fi

    ok "Disk space: ${avail_mb} MB available (need ${required_mb} MB)"
    return 0
}

# ==============================================================================
# Kernel driver blacklist (RTL-SDR)
# ==============================================================================

setup_rtlsdr_blacklist() {
    local blacklist_file="/etc/modprobe.d/blacklist-rtlsdr.conf"

    if [[ -f "$blacklist_file" ]]; then
        ok "RTL-SDR kernel driver blacklist already present"
        return 0
    fi

    if $IS_JETSON; then
        # On Jetson, the DVB drivers are rarely loaded, but check anyway
        local loaded=false
        for mod in dvb_usb_rtl28xxu rtl2832 rtl2830 r820t; do
            if lsmod 2>/dev/null | grep -q "^${mod}"; then
                loaded=true
                break
            fi
        done
        if ! $loaded; then
            ok "No conflicting DVB kernel drivers loaded (Jetson typically does not load them)"
            return 0
        fi
    fi

    info "Creating RTL-SDR kernel driver blacklist..."
    $SUDO tee "$blacklist_file" >/dev/null <<'BLACKLIST'
# Blacklist DVB-T kernel drivers to allow RTL-SDR userspace access.
# Installed by VALENTINE RF installer.
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830
blacklist r820t
BLACKLIST

    # Unload if currently loaded (safe — no DKMS, no kernel module install)
    for mod in dvb_usb_rtl28xxu rtl2832 rtl2830 r820t; do
        if lsmod 2>/dev/null | grep -q "^${mod}"; then
            $SUDO modprobe -r "$mod" 2>/dev/null || true
        fi
    done

    ok "Kernel driver blacklist installed"
}

# ==============================================================================
# udev rules for RTL-SDR non-root access
# ==============================================================================

setup_rtlsdr_udev() {
    local rules_file="/etc/udev/rules.d/20-rtlsdr.rules"

    if [[ ! -d /etc/udev/rules.d ]]; then
        warn "udev rules directory not found — skipping RTL-SDR udev setup"
        return 0
    fi

    if [[ -f "$rules_file" ]]; then
        ok "RTL-SDR udev rules already present"
        return 0
    fi

    info "Installing RTL-SDR udev rules for non-root USB access..."
    $SUDO tee "$rules_file" >/dev/null <<'UDEV'
# RTL-SDR USB device access rules.
# Installed by VALENTINE RF installer.
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", MODE="0666"
UDEV

    $SUDO udevadm control --reload-rules 2>/dev/null || true
    $SUDO udevadm trigger 2>/dev/null || true
    ok "udev rules installed (unplug/replug RTL-SDR if connected)"
}
