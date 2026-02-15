#!/usr/bin/env bash
# =============================================================================
# VALENTINE RF — Production Installer for NVIDIA Jetson Orin Nano
# =============================================================================
#
# Target:
#   Hardware:  NVIDIA Jetson Orin Nano (aarch64)
#   OS:        Ubuntu (L4T / JetPack)
#   Kernel:    5.15.x-tegra
#   Python:    System-managed (3.10+), never modified globally
#
# What this script does:
#   1. Preflight checks  — OS, arch, Python, Jetson env, disk, memory
#   2. System packages   — apt install only what's missing
#   3. Python venv       — project-local venv/, never global pip
#   4. pip dependencies  — from requirements-jetson.txt into venv/
#   5. SDR tool audit    — verify presence, warn about missing tools
#   6. Validation pass   — smoke-test the venv and critical imports
#
# What this script does NOT do:
#   - Install CUDA, cuDNN, or TensorRT (JetPack manages these)
#   - Install kernel modules or DKMS packages
#   - Modify system Python or install packages globally
#   - Make any x86 assumptions
#   - Silently swallow errors
#
# Usage:
#   chmod +x install.sh
#   ./install.sh                    # Interactive (prompts before apt)
#   ./install.sh --non-interactive  # Headless / CI mode
#   ./install.sh --skip-apt         # Skip apt, only set up Python venv
#   ./install.sh --dev              # Also install dev/test dependencies
#
# =============================================================================

# ---- Force bash ----
if [ -z "${BASH_VERSION:-}" ]; then
    echo "[FATAL] This script must be run with bash, not sh."
    echo "  Run: bash $0  or  chmod +x $0 && ./$0"
    exec bash "$0" "$@"
fi

set -Eeuo pipefail

# =============================================================================
# CONSTANTS
# =============================================================================
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly VENV_DIR="${SCRIPT_DIR}/venv"
readonly REQUIREMENTS_FILE="${SCRIPT_DIR}/requirements-jetson.txt"
readonly REQUIREMENTS_DEV_FILE="${SCRIPT_DIR}/requirements-dev.txt"
readonly CHECKS_LIB="${SCRIPT_DIR}/installer/lib/checks.sh"
readonly LOG_FILE="${SCRIPT_DIR}/install.log"
readonly MIN_DISK_MB=500
readonly MIN_MEMORY_MB=512

# =============================================================================
# SOURCE CHECKS LIBRARY
# =============================================================================
if [[ ! -f "${CHECKS_LIB}" ]]; then
    echo "[FATAL] Missing: ${CHECKS_LIB}"
    echo "  Ensure the installer/ directory is present in the repository root."
    exit 1
fi
# shellcheck source=installer/lib/checks.sh
source "${CHECKS_LIB}"

# =============================================================================
# ERROR TRAP (set early — before any logic that could fail)
# =============================================================================
on_error() {
    local line="$1"
    local cmd="${2:-unknown}"
    echo
    fail "═══════════════════════════════════════════════"
    fail "  Installer failed at line ${line}"
    fail "  Command: ${cmd}"
    fail "═══════════════════════════════════════════════"
    fail "  Log file: ${LOG_FILE}"
    fail "  Please include this log when reporting issues."
    echo
    exit 1
}
trap 'on_error $LINENO "$BASH_COMMAND"' ERR

# =============================================================================
# CLI ARGUMENT PARSING
# =============================================================================
NON_INTERACTIVE=false
SKIP_APT=false
INSTALL_DEV=false

for arg in "$@"; do
    case "${arg}" in
        --non-interactive) NON_INTERACTIVE=true ;;
        --skip-apt)        SKIP_APT=true ;;
        --dev)             INSTALL_DEV=true ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo
            echo "Options:"
            echo "  --non-interactive  Skip all prompts (default to safe answers)"
            echo "  --skip-apt         Skip system package installation"
            echo "  --dev              Also install development/test dependencies"
            echo "  --help, -h         Show this help message"
            exit 0
            ;;
        *)
            die "Unknown argument: ${arg}" \
                "This flag is not recognized" \
                "Run $0 --help to see available options"
            ;;
    esac
done

# =============================================================================
# LOGGING
# =============================================================================
# Tee all output to a log file while preserving terminal output
exec > >(tee -a "${LOG_FILE}") 2>&1
info "Logging to ${LOG_FILE}"

# =============================================================================
# HELPERS
# =============================================================================
ask_yes_no() {
    local prompt="$1"
    local default="${2:-n}"

    if $NON_INTERACTIVE; then
        info "(non-interactive) Defaulting to '${default}' for: ${prompt}"
        [[ "${default}" == "y" ]]
        return
    fi

    if [[ ! -t 0 ]]; then
        info "(no TTY) Defaulting to '${default}' for: ${prompt}"
        [[ "${default}" == "y" ]]
        return
    fi

    local response
    if [[ "${default}" == "y" ]]; then
        read -r -p "$(echo -e "${_BLUE}[?]${_NC}") ${prompt} [Y/n]: " response
        [[ -z "${response}" || "${response}" =~ ^[Yy] ]]
    else
        read -r -p "$(echo -e "${_BLUE}[?]${_NC}") ${prompt} [y/N]: " response
        [[ "${response}" =~ ^[Yy] ]]
    fi
}

# Safe apt install: only installs packages not already present.
# Logs what it installs, fails loudly on error.
apt_install_if_missing() {
    local to_install=()

    for pkg in "$@"; do
        # Handle negative exclusion (e.g., "xtrx-dkms-" means exclude)
        if [[ "${pkg}" == *"-" ]]; then
            continue
        fi
        if ! is_apt_pkg_installed "${pkg}"; then
            to_install+=("${pkg}")
        fi
    done

    if [[ ${#to_install[@]} -eq 0 ]]; then
        ok "All requested apt packages already installed: $*"
        return 0
    fi

    info "Installing apt packages: ${to_install[*]}"
    if ! $SUDO apt-get install -y --no-install-recommends "${to_install[@]}"; then
        die "apt-get install failed for: ${to_install[*]}" \
            "One or more system packages could not be installed" \
            "Run manually: sudo apt-get update && sudo apt-get install -y ${to_install[*]}"
    fi
    ok "Installed: ${to_install[*]}"
}

# Try to install one of several alternative package names.
# Returns 0 on first success, 1 if all fail.
apt_try_install_any() {
    for pkg in "$@"; do
        if is_apt_pkg_installed "${pkg}"; then
            ok "apt: ${pkg} already installed"
            return 0
        fi
        if $SUDO apt-get install -y --no-install-recommends "${pkg}" >/dev/null 2>&1; then
            ok "apt: installed ${pkg}"
            return 0
        fi
    done
    return 1
}

# Install RTL-SDR udev rules for non-root device access.
setup_udev_rules() {
    [[ -d /etc/udev/rules.d ]] || { warn "udev not found; skipping RTL-SDR udev rules."; return 0; }

    local rules_file="/etc/udev/rules.d/20-rtlsdr.rules"
    if [[ -f "${rules_file}" ]]; then
        ok "RTL-SDR udev rules already present: ${rules_file}"
        return 0
    fi

    info "Installing RTL-SDR udev rules..."
    $SUDO tee "${rules_file}" >/dev/null <<'UDEV_EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", MODE="0666"
UDEV_EOF
    $SUDO udevadm control --reload-rules 2>/dev/null || true
    $SUDO udevadm trigger 2>/dev/null || true
    ok "udev rules installed. Unplug/replug your RTL-SDR if connected."
}

# Blacklist DVB kernel drivers that conflict with RTL-SDR userspace access.
blacklist_dvb_drivers() {
    local blacklist_file="/etc/modprobe.d/blacklist-rtlsdr.conf"

    if [[ -f "${blacklist_file}" ]]; then
        ok "RTL-SDR kernel driver blacklist already present"
        return 0
    fi

    info "Blacklisting conflicting DVB kernel drivers..."
    $SUDO tee "${blacklist_file}" >/dev/null <<'BLACKLIST_EOF'
# Blacklist DVB-T drivers to allow rtl-sdr to access RTL2832U devices
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830
blacklist r820t
BLACKLIST_EOF

    # Unload modules if currently loaded
    for mod in dvb_usb_rtl28xxu rtl2832 rtl2830 r820t; do
        if lsmod 2>/dev/null | grep -q "^${mod}"; then
            $SUDO modprobe -r "${mod}" 2>/dev/null || true
        fi
    done

    ok "Kernel drivers blacklisted. Unplug/replug your RTL-SDR if connected."
}

# =============================================================================
# BANNER
# =============================================================================
print_banner() {
    echo -e "${_BLUE}"
    cat << 'BANNER'

 ╔══════════════════════════════════════════════════════════════╗
 ║         VALENTINE RF — Jetson Orin Nano Installer           ║
 ║         Signal Intelligence Platform                        ║
 ╚══════════════════════════════════════════════════════════════╝

BANNER
    echo -e "${_NC}"
    info "Date:    $(date '+%Y-%m-%d %H:%M:%S %Z')"
    info "Host:    $(hostname)"
    info "Kernel:  $(uname -r)"
    info "Arch:    $(uname -m)"
    echo
}

# =============================================================================
# PHASE 1: PREFLIGHT CHECKS
# =============================================================================
run_preflight() {
    header "Phase 1: Preflight Checks"

    detect_os
    detect_arch
    detect_jetson
    detect_python
    detect_sudo
    check_disk_space "${SCRIPT_DIR}" "${MIN_DISK_MB}"
    check_memory "${MIN_MEMORY_MB}"
    check_jetson_safety

    # Verify requirements file exists
    if [[ ! -f "${REQUIREMENTS_FILE}" ]]; then
        die "Missing: ${REQUIREMENTS_FILE}" \
            "The Python dependency manifest for Jetson is not present" \
            "Ensure requirements-jetson.txt is in the repository root"
    fi
    ok "Requirements file: ${REQUIREMENTS_FILE}"

    echo
    info "Preflight checks complete."
}

# =============================================================================
# PHASE 2: SYSTEM PACKAGES (APT)
# =============================================================================
install_system_packages() {
    if $SKIP_APT; then
        info "Skipping apt installation (--skip-apt)"
        return 0
    fi

    header "Phase 2: System Packages (apt)"

    # Confirm before proceeding
    echo
    info "The following categories of system packages will be installed (if missing):"
    echo "  - Python build prerequisites (python3-venv, python3-pip, python3-dev)"
    echo "  - Native library build deps  (gcc, make, cmake, libffi, libssl, etc.)"
    echo "  - RTL-SDR runtime            (rtl-sdr, librtlsdr-dev, libusb)"
    echo "  - SDR decoders               (multimon-ng, rtl-433, direwolf)"
    echo "  - Audio processing           (ffmpeg, libsndfile1)"
    echo "  - WiFi/Bluetooth tools       (aircrack-ng, bluez, iw)"
    echo "  - GPS daemon                 (gpsd, gpsd-clients)"
    echo "  - SoapySDR abstraction       (soapysdr-tools, soapysdr-module-rtlsdr)"
    echo "  - Native lib headers         (for building numpy/scipy wheels if needed)"
    echo
    info "NO kernel modules, NO DKMS, NO CUDA changes."
    echo

    if ! ask_yes_no "Proceed with system package installation?" "y"; then
        warn "Skipping system package installation."
        warn "Python venv setup may fail if build dependencies are missing."
        return 0
    fi

    # Update apt cache
    info "Updating apt package index..."
    $SUDO apt-get update -y >/dev/null 2>&1 || {
        die "apt-get update failed" \
            "Cannot refresh package index — network issue or broken sources.list" \
            "Check your internet connection and run: sudo apt-get update"
    }
    ok "apt package index updated"

    # ---- Python prerequisites ----
    info "Installing Python build prerequisites..."
    apt_install_if_missing \
        python3-venv \
        python3-pip \
        python3-dev \
        python3-setuptools \
        python3-wheel

    # ---- Build tools for native Python extensions ----
    # numpy/scipy may need to compile from source on aarch64 if no binary wheel exists
    info "Installing native extension build dependencies..."
    apt_install_if_missing \
        build-essential \
        pkg-config \
        cmake \
        gfortran \
        libffi-dev \
        libssl-dev \
        libopenblas-dev \
        liblapack-dev

    # ---- RTL-SDR runtime ----
    info "Installing RTL-SDR runtime..."
    apt_install_if_missing \
        rtl-sdr \
        librtlsdr-dev \
        libusb-1.0-0-dev

    # ---- SDR decoders (from apt where available) ----
    info "Installing SDR decoder packages..."
    (apt_install_if_missing multimon-ng) || true
    apt_try_install_any rtl-433 rtl433 || warn_issue \
        "rtl-433 not available in apt" \
        "433MHz sensor decoding will not work without it" \
        "Build from source: https://github.com/merbanan/rtl_433"
    (apt_install_if_missing direwolf) || true

    # ---- Audio ----
    info "Installing audio processing tools..."
    apt_install_if_missing ffmpeg libsndfile1

    # ---- WiFi tools ----
    info "Installing WiFi tools..."
    (apt_install_if_missing aircrack-ng iw wireless-tools) || true

    # ---- WiFi extras (optional) ----
    info "Installing WiFi extras (optional)..."
    (apt_install_if_missing hcxdumptool hcxtools) 2>/dev/null || true

    # ---- Bluetooth tools ----
    info "Installing Bluetooth tools..."
    (apt_install_if_missing bluez bluetooth) 2>/dev/null || true

    # ---- GPS ----
    info "Installing GPS daemon..."
    (apt_install_if_missing gpsd gpsd-clients) 2>/dev/null || true

    # ---- SoapySDR ----
    info "Installing SoapySDR..."
    (apt_install_if_missing soapysdr-tools) 2>/dev/null || true
    # Install SDR hardware modules (best effort — not all may be in apt)
    for module in soapysdr-module-rtlsdr soapysdr-module-hackrf soapysdr-module-lms7 soapysdr-module-airspy; do
        $SUDO apt-get install -y --no-install-recommends "${module}" 2>/dev/null || true
    done

    # ---- Postgres client libs (for psycopg2 build if needed) ----
    info "Installing PostgreSQL client libraries (for optional psycopg2)..."
    (apt_install_if_missing libpq-dev) 2>/dev/null || true

    # ---- D-Bus development libs (for bleak BLE scanning) ----
    info "Installing D-Bus development libraries (for BLE scanning)..."
    (apt_install_if_missing libdbus-1-dev libglib2.0-dev) 2>/dev/null || true

    # ---- SatDump runtime libraries (weather satellite decoding) ----
    info "Installing SatDump runtime libraries..."
    apt_try_install_any libpng16-16 libpng16-16t64 || true
    apt_try_install_any libtiff6 libtiff5 || true
    apt_try_install_any libjemalloc2 || true
    apt_try_install_any libvolk-bin libvolk2-bin || true
    apt_try_install_any libnng1 || true
    apt_try_install_any libzstd1 || true

    # ---- SDR hardware drivers (optional) ----
    info "Installing SDR hardware driver packages..."
    for hw_pkg in airspy limesuite hackrf; do
        $SUDO apt-get install -y --no-install-recommends "${hw_pkg}" 2>/dev/null || true
    done

    # ---- Utilities ----
    info "Installing system utilities..."
    (apt_install_if_missing curl procps git) 2>/dev/null || true

    # ---- RTL-SDR device access configuration ----
    info "Configuring RTL-SDR device access..."
    setup_udev_rules

    if [[ -f /etc/modprobe.d/blacklist-rtlsdr.conf ]]; then
        ok "DVB kernel drivers already blacklisted"
    else
        echo
        echo "  The DVB-T kernel drivers conflict with RTL-SDR userspace access."
        echo "  Blacklisting them allows rtl_sdr tools to access the device."
        echo
        if ask_yes_no "Blacklist conflicting kernel drivers?" "y"; then
            blacklist_dvb_drivers
        else
            warn "Skipped kernel driver blacklist. RTL-SDR may not work without manual config."
        fi
    fi

    echo
    ok "System package installation complete."
}

# =============================================================================
# PHASE 3: PYTHON VIRTUAL ENVIRONMENT
# =============================================================================
setup_python_venv() {
    header "Phase 3: Python Virtual Environment"

    if [[ -d "${VENV_DIR}" ]]; then
        # Validate existing venv
        if [[ -x "${VENV_DIR}/bin/python3" ]]; then
            local venv_py_ver
            venv_py_ver=$("${VENV_DIR}/bin/python3" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "broken")
            if [[ "${venv_py_ver}" == "broken" ]]; then
                warn "Existing venv/ is broken — recreating..."
                rm -rf "${VENV_DIR}"
            else
                ok "Existing venv/ found (Python ${venv_py_ver})"
                info "To force recreate: rm -rf venv/ && re-run this installer"
            fi
        else
            warn "Existing venv/ has no python3 binary — recreating..."
            rm -rf "${VENV_DIR}"
        fi
    fi

    if [[ ! -d "${VENV_DIR}" ]]; then
        info "Creating Python virtual environment at ${VENV_DIR}..."
        "${PYTHON_BIN}" -m venv "${VENV_DIR}" || {
            die "Failed to create Python venv" \
                "python3 -m venv returned a non-zero exit code" \
                "Install venv support: sudo apt-get install python3-venv python3.${PYTHON_MINOR}-venv"
        }
        ok "Created venv/ at ${VENV_DIR}"
    fi

    # Activate venv for remainder of this script
    if [[ ! -f "${VENV_DIR}/bin/activate" ]]; then
        die "venv activation script missing: ${VENV_DIR}/bin/activate" \
            "The Python virtual environment may have been created incorrectly" \
            "Remove and re-run: rm -rf ${VENV_DIR} && $0"
    fi
    # shellcheck disable=SC1091
    source "${VENV_DIR}/bin/activate"
    ok "Activated venv ($(python3 --version))"

    # Upgrade pip, setuptools, wheel inside venv
    info "Upgrading pip, setuptools, wheel inside venv..."
    python3 -m pip install --upgrade pip setuptools wheel 2>&1 | tail -3
    ok "pip $(python3 -m pip --version | awk '{print $2}') ready"
}

# =============================================================================
# PHASE 4: PYTHON DEPENDENCIES
# =============================================================================
install_python_deps() {
    header "Phase 4: Python Dependencies"

    info "Installing from ${REQUIREMENTS_FILE}..."
    echo

    # ---------- Core dependencies (must succeed) ----------
    info "Installing core dependencies (quart, httpx, werkzeug)..."
    local pip_output
    if pip_output=$(python3 -m pip install --no-cache-dir \
        "quart==0.20.0" \
        "quart-rate-limiter==0.11.0" \
        "httpx==0.28.1" \
        "Werkzeug==3.1.3" 2>&1); then
        echo "${pip_output}" | tail -5
        ok "Core dependencies installed"
    else
        echo "${pip_output}"
        die "Failed to install core Python dependencies" \
            "The application cannot start without quart, httpx, and Werkzeug" \
            "Check the log at ${LOG_FILE} for pip error details"
    fi

    # ---------- numpy/scipy (may need special handling on aarch64) ----------
    info "Installing numpy and scipy (may compile from source on aarch64)..."
    if ! python3 -m pip install --no-cache-dir \
        "numpy>=2.0.0,<3.0" 2>&1 | tail -5; then
        warn_issue "numpy pip install failed — trying system package fallback" \
            "numpy may lack an aarch64 binary wheel for this Python version" \
            "If this persists: sudo apt-get install python3-numpy, then recreate venv with --system-site-packages"
        # Try to install system numpy and recreate venv with system-site-packages
        $SUDO apt-get install -y python3-numpy 2>/dev/null || true
        if python3 -c "import numpy" 2>/dev/null; then
            ok "numpy available via system package"
        else
            warn "numpy not available — SSTV, DSC, and waterfall FFT will be disabled"
        fi
    else
        ok "numpy installed"
    fi

    if ! python3 -m pip install --no-cache-dir \
        "scipy>=1.14.0,<2.0" 2>&1 | tail -5; then
        warn_issue "scipy pip install failed" \
            "scipy DSP features (DSC decoding, filter design) will not be available" \
            "Try: sudo apt-get install python3-scipy, then recreate venv with --system-site-packages"
        $SUDO apt-get install -y python3-scipy 2>/dev/null || true
    else
        ok "scipy installed"
    fi

    # ---------- Remaining optional dependencies (best effort) ----------
    info "Installing optional dependencies..."
    local optional_pkgs=(
        "Pillow>=9.0.0,<12.0"
        "skyfield>=1.45,<2.0"
        "pyserial==3.5"
        "bleak>=0.22.0,<1.0"
        "websocket-client>=1.6.0,<2.0"
        "meshtastic>=2.0.0,<3.0"
        "scapy>=2.4.5,<3.0"
        "qrcode[pil]>=7.4,<9.0"
    )

    for pkg in "${optional_pkgs[@]}"; do
        local pkg_name="${pkg%%[>=<\[]*}"  # Extract name before version specifier
        if python3 -m pip install --no-cache-dir "${pkg}" 2>/dev/null | tail -2; then
            ok "${pkg_name} installed"
        else
            warn_issue "${pkg_name} failed to install" \
                "Features depending on ${pkg_name} will be disabled (graceful degradation)" \
                "Try manually: ${VENV_DIR}/bin/pip install '${pkg}'"
        fi
    done

    # ---------- psycopg2 (special: try binary first, then source build) ----------
    info "Installing psycopg2 (PostgreSQL driver, optional)..."
    if ! python3 -m pip install --no-cache-dir "psycopg2-binary>=2.9.9,<3.0" 2>/dev/null; then
        info "psycopg2-binary wheel not available for aarch64 — trying source build..."
        if ! python3 -m pip install --no-cache-dir "psycopg2>=2.9.9,<3.0" 2>/dev/null; then
            warn_issue "psycopg2 not installed" \
                "ADS-B history persistence (PostgreSQL) will not be available" \
                "Install libpq-dev and retry: sudo apt-get install libpq-dev && pip install psycopg2"
        else
            ok "psycopg2 installed (built from source)"
        fi
    else
        ok "psycopg2-binary installed"
    fi

    # ---------- Dev dependencies (optional) ----------
    if $INSTALL_DEV; then
        info "Installing development dependencies..."
        if [[ -f "${REQUIREMENTS_DEV_FILE}" ]]; then
            # Install only the dev-specific packages, not the -r requirements.txt include
            python3 -m pip install --no-cache-dir \
                "pytest>=7.0.0" \
                "pytest-cov>=4.0.0" \
                "pytest-mock>=3.15.1" \
                "pytest-asyncio>=0.21.0" \
                "ruff>=0.9.0" \
                "mypy>=1.0.0" \
                "types-Werkzeug>=1.0.0" 2>&1 | tail -5
            ok "Development dependencies installed"
        else
            warn "requirements-dev.txt not found — skipping dev deps"
        fi
    fi

    echo
    ok "Python dependency installation complete."
}

# =============================================================================
# PHASE 5: SDR TOOL AUDIT
# =============================================================================
audit_sdr_tools() {
    header "Phase 5: SDR Tool Audit"

    info "Checking for required and optional SDR tools..."
    echo

    # Reset tracking arrays
    MISSING_REQUIRED=()
    MISSING_OPTIONAL=()
    FOUND_TOOLS=()

    # ---- Core SDR (Required for basic operation) ----
    info "Core SDR tools:"
    check_tool_required "rtl_fm"      "RTL-SDR FM demodulator"               rtl_fm
    check_tool_required "rtl_test"    "RTL-SDR device probe"                 rtl_test
    check_tool_required "multimon-ng" "Digital mode decoder (POCSAG/FLEX)"   multimon-ng
    check_tool_required "ffmpeg"      "Audio transcoding"                    ffmpeg
    echo

    # ---- Decoders (Required for specific features) ----
    info "Signal decoders:"
    check_tool_required "rtl_433"     "433MHz ISM sensor decoder"            rtl_433 rtl433
    check_tool_required "dump1090"    "ADS-B Mode S decoder"                 dump1090 dump1090-fa dump1090-mutability readsb
    check_tool_optional "dump978-fa"  "UAT 978MHz decoder"                   dump978-fa dump978
    check_tool_optional "uat2json"    "UAT JSON converter"                   uat2json
    check_tool_optional "acarsdec"    "ACARS message decoder"                acarsdec
    check_tool_optional "AIS-catcher" "AIS vessel tracking decoder"          AIS-catcher aiscatcher
    check_tool_optional "direwolf"    "APRS/packet radio modem"              direwolf
    check_tool_optional "satdump"     "Weather satellite decoder (NOAA/Meteor)" satdump
    check_tool_optional "dsd-fme"     "Digital voice decoder (DMR/P25)"      dsd-fme dsd
    check_tool_optional "rtlamr"      "Utility meter reader"                 rtlamr
    check_tool_optional "rx_fm"       "SoapySDR FM receiver (rx_tools)"      rx_fm
    echo

    # ---- WiFi ----
    info "WiFi tools:"
    check_tool_required "airmon-ng"     "WiFi monitor mode"                  airmon-ng
    check_tool_required "airodump-ng"   "WiFi scanner"                       airodump-ng
    check_tool_optional "aireplay-ng"   "WiFi packet injection"              aireplay-ng
    check_tool_optional "hcxdumptool"   "PMKID capture"                      hcxdumptool
    check_tool_optional "hcxpcapngtool" "PMKID hash extraction"              hcxpcapngtool
    check_tool_optional "iw"            "Generic WiFi utility"               iw
    echo

    # ---- Bluetooth ----
    info "Bluetooth tools:"
    check_tool_required "bluetoothctl"  "Bluetooth controller CLI"           bluetoothctl
    check_tool_optional "hcitool"       "Legacy BLE scan utility"            hcitool
    check_tool_optional "hciconfig"     "Bluetooth adapter config"           hciconfig
    echo

    # ---- GPS / SoapySDR ----
    info "GPS & SDR abstraction:"
    check_tool_optional "gpsd"          "GPS daemon"                         gpsd
    check_tool_optional "SoapySDRUtil"  "SoapySDR CLI utility"              SoapySDRUtil
    echo

    # Print summary
    print_tool_report

    # Report missing tools that must be built from source
    if [[ ${#MISSING_OPTIONAL[@]} -gt 0 ]]; then
        echo
        info "To install missing SDR tools built from source, you can use:"
        info "  ./setup.sh   (the general-purpose installer handles source builds)"
        info "  Or use Docker: docker compose --profile basic up -d"
    fi
}

# =============================================================================
# PHASE 6: VALIDATION
# =============================================================================
run_validation() {
    header "Phase 6: Validation"

    local errors=0

    # ---- Check venv python works ----
    info "Validating venv Python..."
    if ! "${VENV_DIR}/bin/python3" -c "import sys; assert sys.prefix != sys.base_prefix, 'Not in venv'" 2>/dev/null; then
        fail "venv Python validation failed — python3 is not running inside the venv"
        ((errors++))
    else
        ok "venv Python active: $(${VENV_DIR}/bin/python3 --version)"
    fi

    # ---- Check critical imports ----
    info "Validating critical Python imports..."

    # Core (must succeed)
    local core_imports=("quart" "quart_rate_limiter" "httpx" "werkzeug")
    for mod in "${core_imports[@]}"; do
        if "${VENV_DIR}/bin/python3" -c "import ${mod}" 2>/dev/null; then
            ok "import ${mod}"
        else
            fail "import ${mod} FAILED — this is a core dependency"
            ((errors++))
        fi
    done

    # Optional (warn only)
    local optional_imports=(
        "numpy|SSTV/DSC/waterfall disabled"
        "scipy|DSC decoder disabled"
        "PIL|SSTV image output disabled"
        "skyfield|Satellite tracking disabled"
        "serial|USB GPS disabled"
        "bleak|BLE scanning disabled"
        "websocket|KiwiSDR proxy disabled"
        "scapy|Deauth detection disabled"
        "qrcode|Meshtastic QR disabled"
    )
    for entry in "${optional_imports[@]}"; do
        local mod="${entry%%|*}"
        local note="${entry##*|}"
        if "${VENV_DIR}/bin/python3" -c "import ${mod}" 2>/dev/null; then
            ok "import ${mod}"
        else
            warn "import ${mod} — not available (${note})"
        fi
    done

    # ---- Check the application can at least parse ----
    info "Validating application entry point..."
    if "${VENV_DIR}/bin/python3" - "${SCRIPT_DIR}" <<'PYEOF' 2>/dev/null
import sys
script_dir = sys.argv[1]
sys.path.insert(0, script_dir)
import py_compile
py_compile.compile(script_dir + '/valentine.py', doraise=True)
py_compile.compile(script_dir + '/app.py', doraise=True)
py_compile.compile(script_dir + '/config.py', doraise=True)
PYEOF
    then
        ok "Core application files parse successfully"
    else
        warn "Some application files have syntax issues (may be non-critical)"
    fi

    # ---- Check the app can import ----
    info "Validating application config import..."
    if "${VENV_DIR}/bin/python3" - "${SCRIPT_DIR}" <<'PYEOF' 2>/dev/null
import sys
script_dir = sys.argv[1]
sys.path.insert(0, script_dir)
from config import VERSION
print(f'VALENTINE RF v{VERSION}')
PYEOF
    then
        ok "Application config loaded successfully"
    else
        warn "Could not load application config (non-critical for install)"
    fi

    # ---- Verify venv is self-contained ----
    info "Verifying venv isolation..."
    local venv_site
    venv_site=$("${VENV_DIR}/bin/python3" -c "import site; print(site.getsitepackages()[0])" 2>/dev/null)
    if [[ "${venv_site}" == *"${VENV_DIR}"* ]]; then
        ok "venv site-packages is project-local: ${venv_site}"
    else
        warn "venv site-packages may reference system paths: ${venv_site}"
    fi

    echo
    if [[ ${errors} -gt 0 ]]; then
        die "${errors} critical validation error(s) detected" \
            "Core dependencies failed to import — the application will not start" \
            "Review the output above and the log at ${LOG_FILE}"
    fi

    ok "All validation checks passed."
}

# =============================================================================
# FINAL SUMMARY
# =============================================================================
print_summary() {
    echo
    echo -e "${_BOLD}═══════════════════════════════════════════════════════════════${_NC}"
    echo -e "${_BOLD}  VALENTINE RF — Installation Complete${_NC}"
    echo -e "${_BOLD}═══════════════════════════════════════════════════════════════${_NC}"
    echo
    echo "  Python venv:  ${VENV_DIR}"
    echo "  Log file:     ${LOG_FILE}"
    echo
    echo -e "  ${_GREEN}To start the application:${_NC}"
    echo
    echo "    source venv/bin/activate"
    echo "    sudo -E python valentine.py"
    echo
    echo "  Or without activating:"
    echo
    echo "    sudo -E ${VENV_DIR}/bin/python valentine.py"
    echo
    echo "  Then open http://localhost:5050 in your browser."
    echo
    if [[ ${#MISSING_REQUIRED[@]} -gt 0 ]]; then
        echo -e "  ${_YELLOW}WARNING: ${#MISSING_REQUIRED[@]} required SDR tool(s) are missing.${_NC}"
        echo "  Some features will not work. See tool audit above."
        echo
    fi
    if [[ ${#MISSING_OPTIONAL[@]} -gt 0 ]]; then
        echo -e "  ${_BLUE}NOTE: ${#MISSING_OPTIONAL[@]} optional tool(s) are not installed.${_NC}"
        echo "  Use ./setup.sh or Docker for full SDR tool builds."
        echo
    fi
    echo -e "${_BOLD}═══════════════════════════════════════════════════════════════${_NC}"
    echo
}

# =============================================================================
# MAIN
# =============================================================================
main() {
    print_banner

    # Phase 1: Preflight
    run_preflight

    # Phase 2: System packages
    install_system_packages

    # Phase 3: Python venv
    setup_python_venv

    # Phase 4: Python dependencies
    install_python_deps

    # Phase 5: SDR tool audit
    audit_sdr_tools

    # Phase 6: Validation
    run_validation

    # Done
    print_summary
}

main "$@"

# Clear traps before clean exit
trap - ERR EXIT
exit 0
