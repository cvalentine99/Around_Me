#!/usr/bin/env bash
# ==============================================================================
# VALENTINE RF — Production Installer
# ==============================================================================
#
# A production-grade installer for VALENTINE RF on Debian/Ubuntu systems,
# with first-class support for NVIDIA Jetson (aarch64 / L4T / JetPack).
#
# Usage:
#   ./install.sh                  Interactive install (prompts for optional tools)
#   ./install.sh --non-interactive  Headless install (skips optional builds)
#   ./install.sh --skip-sdr-build   Skip building SDR tools from source
#   ./install.sh --dry-run          Show what would be done, change nothing
#
# Safety guarantees:
#   - Never installs Python packages globally
#   - Never modifies system Python or apt Python packages
#   - Never installs CUDA drivers or kernel modules (DKMS)
#   - Never auto-starts the application
#   - Idempotent: safe to re-run
#
# Exit codes:
#   0  Success
#   1  Fatal error (details printed)
#   2  Preflight check failed
# ==============================================================================

# ---- Strict mode ----
set -Euo pipefail

# ---- Force bash ----
if [[ -z "${BASH_VERSION:-}" ]]; then
    echo "[FATAL] This script requires bash. Run: bash $0 $*"
    exit 1
fi

# Bash 4+ required for associative arrays and other features
if [[ "${BASH_VERSINFO[0]}" -lt 4 ]]; then
    echo "[FATAL] Bash 4.0+ required. Found: ${BASH_VERSION}"
    echo "  On Ubuntu/Debian: sudo apt install bash"
    exit 1
fi

# ==============================================================================
# Locate ourselves and source the helper library
# ==============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKS_LIB="${SCRIPT_DIR}/installer/lib/checks.sh"

if [[ ! -f "$CHECKS_LIB" ]]; then
    echo "[FATAL] Helper library not found: ${CHECKS_LIB}"
    echo "  Ensure the installer/ directory is present alongside install.sh"
    exit 1
fi

# shellcheck source=installer/lib/checks.sh
source "$CHECKS_LIB"

# ==============================================================================
# Parse arguments
# ==============================================================================
NON_INTERACTIVE=false
SKIP_SDR_BUILD=false
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --non-interactive) NON_INTERACTIVE=true ;;
        --skip-sdr-build)  SKIP_SDR_BUILD=true ;;
        --dry-run)         DRY_RUN=true ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo
            echo "Options:"
            echo "  --non-interactive   Skip all prompts (use safe defaults)"
            echo "  --skip-sdr-build    Skip building SDR tools from source"
            echo "  --dry-run           Show what would be done without making changes"
            echo "  --help, -h          Show this help message"
            exit 0
            ;;
        *)
            warn "Unknown argument: ${arg} (ignored)"
            ;;
    esac
done

export NON_INTERACTIVE

# ==============================================================================
# Error trap
# ==============================================================================
on_error() {
    local line="$1"
    local cmd="${2:-unknown}"
    echo
    fail "Installer failed at line ${line}"
    detail "Command: ${cmd}"
    detail "Re-run with 'bash -x install.sh' for debug output"
    exit 1
}
trap 'on_error $LINENO "$BASH_COMMAND"' ERR

# ==============================================================================
# Banner
# ==============================================================================
echo -e "${BLUE}"
cat <<'BANNER'

 __     __    _            _   _              ____  _____
 \ \   / /_ _| | ___ _ __ | |_(_)_ __   ___  |  _ \|  ___|
  \ \ / / _` | |/ _ \ '_ \| __| | '_ \ / _ \ | |_) | |_
   \ V / (_| | |  __/ | | | |_| | | | |  __/ |  _ <|  _|
    \_/ \__,_|_|\___|_| |_|\__|_|_| |_|\___| |_| \_\_|

BANNER
echo -e "${NC}"
echo "  VALENTINE RF — Production Installer"
echo "  Target: Debian/Ubuntu (Jetson aarch64 optimized)"
echo "  =================================================="
echo

# ==============================================================================
# Phase 1: Preflight Checks
# ==============================================================================
section "Phase 1: Preflight System Audit"

# Detect environment
detect_os     || exit 2
detect_arch   || exit 2
detect_jetson
detect_python || exit 2

# Jetson-specific safety assertions
if $IS_JETSON; then
    section "Jetson Safety Assertions"
    ok "Will NOT install CUDA drivers (JetPack manages CUDA)"
    ok "Will NOT install kernel modules or use DKMS"
    ok "Will NOT modify tegra kernel configuration"
    ok "Will use python3 -m venv (not conda, not poetry)"
fi

# Verify we are in the project directory
if [[ ! -f "${SCRIPT_DIR}/valentine.py" ]]; then
    fail "valentine.py not found in ${SCRIPT_DIR}"
    detail "WHAT FAILED: Project directory validation"
    detail "WHY IT MATTERS: Installer must run from the VALENTINE RF project root"
    detail "HOW TO FIX: cd into the project directory and run ./install.sh"
    exit 2
fi

if [[ ! -f "${SCRIPT_DIR}/requirements.txt" ]]; then
    fail "requirements.txt not found in ${SCRIPT_DIR}"
    detail "WHAT FAILED: Dependency file check"
    detail "WHY IT MATTERS: Python dependencies cannot be installed without this file"
    detail "HOW TO FIX: Ensure you cloned the full repository"
    exit 2
fi

# Check disk space (500 MB minimum for packages + venv + build)
check_disk_space "${SCRIPT_DIR}" 500 || exit 2

# Resolve sudo access
resolve_sudo || exit 2

# Check venv availability
check_venv_available || {
    info "Attempting to install python3-venv..."
    $SUDO apt-get update -y >/dev/null 2>&1
    $SUDO apt-get install -y python3-venv >/dev/null 2>&1
    check_venv_available || exit 2
}

# Port check (informational, non-blocking)
check_port_available 5050 "VALENTINE RF web interface" || true

echo

# ==============================================================================
# Pre-install summary
# ==============================================================================
section "Installation Plan"
echo
echo "  OS:           ${DETECTED_OS} ${DETECTED_OS_VERSION} (${DETECTED_OS_CODENAME})"
echo "  Architecture: ${DETECTED_ARCH}"
echo "  Python:       ${PYTHON_VERSION} (${PYTHON_BIN})"
$IS_JETSON && echo "  Jetson:       ${JETSON_BOARD:-detected} (L4T ${JETSON_L4T_VERSION:-unknown})"
echo "  Project:      ${SCRIPT_DIR}"
echo
echo "  This installer will:"
echo "    1. Install missing system packages via apt (only what is missing)"
echo "    2. Create a Python venv at ${SCRIPT_DIR}/venv/"
echo "    3. Install Python dependencies inside the venv"
echo "    4. Configure udev rules for RTL-SDR non-root access"
echo "    5. Optionally build SDR tools from source (dump1090, acarsdec, etc.)"
echo "    6. Run a final validation pass"
echo
echo "  This installer will NOT:"
echo "    - Install Python packages globally"
echo "    - Modify system Python or CUDA"
echo "    - Install kernel modules or use DKMS"
echo "    - Auto-start the application"
echo

if $DRY_RUN; then
    info "DRY RUN: No changes will be made. Exiting."
    exit 0
fi

if ! ask_yes_no "Proceed with installation?" "y"; then
    info "Installation cancelled by user."
    exit 0
fi

echo

# ==============================================================================
# Phase 2: System Package Installation
# ==============================================================================
section "Phase 2: System Packages (apt)"

INSTALLER_TOTAL_STEPS=14
INSTALLER_CURRENT_STEP=0

# Update package lists
progress "Updating apt package lists"
$SUDO apt-get update -y >/dev/null 2>&1
ok "Package lists updated"

# ---- Core system libraries ----
progress "Core libraries (USB, audio, compression)"
apt_install_batch \
    libusb-1.0-0-dev \
    libsndfile1 \
    libpng16-16 \
    zlib1g \
    curl \
    procps \
    2>/dev/null || warn "Some core libraries could not be installed"

# ---- Python build support ----
progress "Python build support"
apt_install_batch \
    python3-venv \
    python3-pip \
    python3-dev \
    python3-setuptools \
    python3-wheel \
    2>/dev/null || warn "Some Python build packages could not be installed"

# ---- RTL-SDR ----
progress "RTL-SDR tools"
apt_install_batch \
    rtl-sdr \
    librtlsdr-dev \
    2>/dev/null || warn "RTL-SDR packages not available — SDR features will not work"

# ---- Pager decoder ----
progress "Pager decoder (multimon-ng)"
apt_install_if_missing multimon-ng 2>/dev/null || warn "multimon-ng not available"

# ---- 433 MHz decoder ----
progress "433 MHz sensor decoder (rtl_433)"
apt_try_any rtl-433 rtl433 2>/dev/null || warn "rtl_433 not available via apt"

# ---- Audio / media ----
progress "Audio tools (ffmpeg)"
apt_install_if_missing ffmpeg 2>/dev/null || warn "ffmpeg not available"

# ---- WiFi tools ----
progress "WiFi tools (aircrack-ng suite)"
apt_install_batch \
    aircrack-ng \
    iw \
    wireless-tools \
    2>/dev/null || warn "WiFi tools not available"

# ---- WiFi extras (hcxtools) ----
progress "WiFi extras (hcxtools)"
apt_install_batch \
    hcxdumptool \
    hcxtools \
    2>/dev/null || warn "hcxtools not available — PMKID features will be limited"

# ---- Bluetooth ----
progress "Bluetooth tools (BlueZ)"
apt_install_batch \
    bluez \
    bluetooth \
    2>/dev/null || warn "Bluetooth tools not available"

# ---- GPS ----
progress "GPS tools"
apt_install_batch \
    gpsd \
    gpsd-clients \
    2>/dev/null || warn "gpsd not available — GPS features will be limited"

# ---- APRS ----
progress "APRS tools (direwolf)"
apt_install_if_missing direwolf 2>/dev/null || warn "direwolf not available"

# ---- SoapySDR (multi-SDR support) ----
progress "SoapySDR multi-SDR framework"
# Note: xtrx-dkms intentionally excluded (DKMS forbidden, especially on Jetson)
apt_install_batch \
    soapysdr-tools \
    2>/dev/null || warn "SoapySDR not available"

# SoapySDR modules — best-effort, not all may be in repos
for soapy_mod in soapysdr-module-rtlsdr soapysdr-module-hackrf soapysdr-module-lms7 soapysdr-module-airspy; do
    apt_install_if_missing "$soapy_mod" 2>/dev/null || true
done

# ---- Build essentials (needed for from-source SDR tools and pip source builds) ----
progress "Build tools (for source compilation)"
apt_install_batch \
    build-essential \
    git \
    cmake \
    pkg-config \
    2>/dev/null || {
    warn "Build tools not available — from-source SDR builds will be skipped"
    SKIP_SDR_BUILD=true
}

echo

# ==============================================================================
# Phase 3: Python Virtual Environment
# ==============================================================================
section "Phase 3: Python Virtual Environment"

VENV_DIR="${SCRIPT_DIR}/venv"
VENV_PYTHON="${VENV_DIR}/bin/python"
VENV_PIP="${VENV_DIR}/bin/pip"

if [[ -d "$VENV_DIR" ]] && [[ -x "$VENV_PYTHON" ]]; then
    ok "Using existing venv at ${VENV_DIR}"
    # Verify the venv python still works
    if ! "$VENV_PYTHON" -c "import sys; print(sys.version)" >/dev/null 2>&1; then
        warn "Existing venv appears broken — recreating"
        rm -rf "$VENV_DIR"
    fi
fi

if [[ ! -d "$VENV_DIR" ]]; then
    info "Creating Python venv at ${VENV_DIR}..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
    ok "venv created"
fi

# Verify the venv python
if [[ ! -x "$VENV_PYTHON" ]]; then
    fail "venv python not found at ${VENV_PYTHON}"
    detail "WHAT FAILED: venv creation or activation"
    detail "WHY IT MATTERS: All Python packages must be installed in the venv"
    detail "HOW TO FIX: Remove ${VENV_DIR} and re-run the installer"
    exit 1
fi

venv_py_ver="$("$VENV_PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")')"
ok "venv Python: ${venv_py_ver}"

# Upgrade pip, setuptools, wheel inside venv
info "Upgrading pip, setuptools, wheel inside venv..."
"$VENV_PYTHON" -m pip install --upgrade pip setuptools wheel 2>&1 | tail -3
ok "pip toolchain upgraded"

# Check pip version
check_pip_available "$VENV_PYTHON"

# Install Python dependencies from requirements.txt
section "Installing Python Dependencies"
info "Installing from requirements.txt..."

# On aarch64, some packages (numpy, scipy, Pillow) may need compilation from source
# if pre-built wheels are not available. Ensure build deps are present.
if [[ "$DETECTED_ARCH" == "aarch64" ]]; then
    info "aarch64 detected — ensuring native build dependencies for compiled packages"
    apt_install_batch \
        libopenblas-dev \
        liblapack-dev \
        gfortran \
        libjpeg-dev \
        libfreetype6-dev \
        2>/dev/null || warn "Some native build deps missing — pip may fall back to source builds"
fi

# Install requirements with clear error reporting
if "$VENV_PYTHON" -m pip install -r "${SCRIPT_DIR}/requirements.txt" 2>&1 | tail -20; then
    ok "Python dependencies installed"
else
    # If batch install failed, try one by one to identify the problem
    fail "Batch pip install failed — installing packages individually to identify failures"
    while IFS= read -r line; do
        # Skip comments and empty lines
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line// /}" ]] && continue
        pkg="${line%%#*}"   # strip inline comments
        pkg="${pkg// /}"    # strip whitespace
        [[ -z "$pkg" ]] && continue

        if "$VENV_PYTHON" -m pip install "$pkg" 2>/dev/null; then
            ok "pip: ${pkg}"
        else
            fail "pip: ${pkg} FAILED"
            detail "WHAT FAILED: pip install ${pkg}"
            detail "WHY IT MATTERS: This package may be needed for certain features"
            # Check if it's a critical package
            case "$pkg" in
                quart*|httpx*|Werkzeug*|quart-rate-limiter*)
                    fail "This is a CRITICAL dependency — the application will not start without it"
                    detail "HOW TO FIX: Check build dependencies, try: ${VENV_PYTHON} -m pip install ${pkg} -v"
                    ;;
                *)
                    detail "HOW TO FIX: Try installing manually: ${VENV_PYTHON} -m pip install ${pkg}"
                    ;;
            esac
        fi
    done < "${SCRIPT_DIR}/requirements.txt"
fi

echo

# ==============================================================================
# Phase 4: SDR Tools from Source (Optional)
# ==============================================================================
section "Phase 4: SDR Tools from Source"

if $SKIP_SDR_BUILD; then
    info "Skipping from-source SDR builds (--skip-sdr-build)"
else
    # Build dependencies for from-source compilation
    BUILD_DEPS_INSTALLED=false
    install_build_deps() {
        if $BUILD_DEPS_INSTALLED; then return 0; fi
        info "Installing build dependencies for SDR tools..."
        apt_install_batch \
            build-essential git cmake pkg-config \
            librtlsdr-dev libusb-1.0-0-dev \
            libsndfile1-dev libncurses-dev \
            libcurl4-openssl-dev zlib1g-dev \
            2>/dev/null || {
            warn "Could not install all build dependencies — some tools may fail to build"
            return 1
        }
        BUILD_DEPS_INSTALLED=true
    }

    # ---- dump1090 / readsb (ADS-B) ----
    if ! have_any dump1090 readsb dump1090-fa; then
        echo
        info "dump1090/readsb is REQUIRED for ADS-B aircraft tracking."
        if ask_yes_no "Build dump1090 from source?" "y"; then
            install_build_deps
            (
                tmp_dir="$(mktemp -d)"
                trap 'rm -rf "$tmp_dir"' EXIT

                # Try readsb first (preferred)
                info "Building readsb (preferred ADS-B decoder)..."
                if git clone --depth 1 https://github.com/wiedehopf/readsb.git "$tmp_dir/readsb" 2>/dev/null; then
                    cd "$tmp_dir/readsb"
                    if make BLADERF=no PLUTOSDR=no RTLSDR=yes -j"$(nproc)" 2>/dev/null; then
                        $SUDO install -m 0755 readsb /usr/local/bin/readsb
                        $SUDO ln -sf /usr/local/bin/readsb /usr/local/bin/dump1090
                        ok "readsb installed (linked as dump1090)"
                    else
                        warn "readsb build failed — trying dump1090-fa..."
                        cd /tmp
                        rm -rf "$tmp_dir/readsb"

                        if git clone --depth 1 https://github.com/flightaware/dump1090.git "$tmp_dir/dump1090" 2>/dev/null; then
                            cd "$tmp_dir/dump1090"
                            sed -i 's/-Werror//g' Makefile 2>/dev/null || true
                            if make BLADERF=no RTLSDR=yes -j"$(nproc)" 2>/dev/null; then
                                $SUDO install -m 0755 dump1090 /usr/local/bin/dump1090
                                ok "dump1090-fa installed"
                            else
                                fail "dump1090 build also failed"
                                detail "HOW TO FIX: Install build-essential, librtlsdr-dev, and retry"
                            fi
                        fi
                    fi
                else
                    warn "Could not clone readsb repository"
                fi
            ) || true
        fi
    else
        ok "ADS-B decoder already installed"
    fi

    # ---- acarsdec ----
    if ! cmd_exists acarsdec; then
        echo
        info "acarsdec is REQUIRED for ACARS aircraft message decoding."
        if ask_yes_no "Build acarsdec from source?" "y"; then
            install_build_deps
            (
                tmp_dir="$(mktemp -d)"
                trap 'rm -rf "$tmp_dir"' EXIT

                info "Building acarsdec..."
                if git clone --depth 1 https://github.com/TLeconte/acarsdec.git "$tmp_dir/acarsdec" 2>/dev/null; then
                    cd "$tmp_dir/acarsdec"
                    mkdir -p build && cd build
                    if cmake .. -Drtl=ON 2>/dev/null && make -j"$(nproc)" 2>/dev/null; then
                        $SUDO install -m 0755 acarsdec /usr/local/bin/acarsdec
                        ok "acarsdec installed"
                    else
                        fail "acarsdec build failed"
                        detail "HOW TO FIX: Ensure librtlsdr-dev and libsndfile1-dev are installed"
                    fi
                fi
            ) || true
        fi
    else
        ok "acarsdec already installed"
    fi

    # ---- AIS-catcher ----
    if ! have_any AIS-catcher aiscatcher; then
        echo
        info "AIS-catcher is REQUIRED for AIS vessel tracking."
        if ask_yes_no "Build AIS-catcher from source?" "y"; then
            install_build_deps
            (
                tmp_dir="$(mktemp -d)"
                trap 'rm -rf "$tmp_dir"' EXIT

                info "Building AIS-catcher..."
                if git clone --depth 1 https://github.com/jvde-github/AIS-catcher.git "$tmp_dir/AIS-catcher" 2>/dev/null; then
                    cd "$tmp_dir/AIS-catcher"
                    mkdir -p build && cd build
                    if cmake .. 2>/dev/null && make -j"$(nproc)" 2>/dev/null; then
                        $SUDO install -m 0755 AIS-catcher /usr/local/bin/AIS-catcher
                        ok "AIS-catcher installed"
                    else
                        fail "AIS-catcher build failed"
                        detail "HOW TO FIX: Ensure libcurl4-openssl-dev and zlib1g-dev are installed"
                    fi
                fi
            ) || true
        fi
    else
        ok "AIS-catcher already installed"
    fi

    # ---- dump978-fa + uat2json (UAT 978 MHz — optional) ----
    if ! have_any dump978-fa dump978; then
        echo
        info "dump978 decodes UAT 978 MHz (US general aviation). Optional."
        if ask_yes_no "Build dump978 from source?" "n"; then
            install_build_deps
            # dump978 needs librtlsdr-dev and soapysdr
            apt_install_batch libsoapysdr-dev 2>/dev/null || true
            (
                tmp_dir="$(mktemp -d)"
                trap 'rm -rf "$tmp_dir"' EXIT

                info "Building dump978-fa..."
                if git clone --depth 1 --branch v9.0 https://github.com/flightaware/dump978.git "$tmp_dir/dump978" 2>/dev/null; then
                    cd "$tmp_dir/dump978"
                    mkdir -p build && cd build
                    if cmake .. -DCMAKE_INSTALL_PREFIX=/usr/local 2>/dev/null && make -j"$(nproc)" 2>/dev/null; then
                        $SUDO install -m 0755 dump978-fa /usr/local/bin/dump978-fa
                        $SUDO install -m 0755 uat2json /usr/local/bin/uat2json 2>/dev/null || true
                        $SUDO install -m 0755 uat2esnt /usr/local/bin/uat2esnt 2>/dev/null || true
                        $SUDO ln -sf /usr/local/bin/dump978-fa /usr/local/bin/dump978
                        ok "dump978-fa and uat2json installed"
                    else
                        warn "dump978 build failed"
                    fi
                fi
            ) || true
        else
            info "Skipping dump978 (UAT decoding will not be available)"
        fi
    else
        ok "dump978 already installed"
    fi

    # ---- SatDump (weather satellites — optional, large build) ----
    if ! cmd_exists satdump; then
        echo
        info "SatDump decodes NOAA APT and Meteor LRPT weather satellite imagery."
        info "Building SatDump from source requires significant compilation time."
        if ask_yes_no "Build SatDump from source?" "n"; then
            install_build_deps
            apt_install_batch \
                libpng-dev libtiff-dev libjemalloc-dev libvolk-dev libnng-dev \
                libzstd-dev libsoapysdr-dev libhackrf-dev liblimesuite-dev \
                libsqlite3-dev libzmq3-dev libfftw3-dev \
                2>/dev/null || true
            (
                tmp_dir="$(mktemp -d)"
                trap 'rm -rf "$tmp_dir"' EXIT

                info "Cloning SatDump v1.2.2..."
                if git clone --depth 1 --branch 1.2.2 https://github.com/SatDump/SatDump.git "$tmp_dir/SatDump" 2>/dev/null; then
                    cd "$tmp_dir/SatDump"
                    mkdir -p build && cd build
                    info "Compiling SatDump (this may take a while on ARM)..."
                    if cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_GUI=OFF -DCMAKE_INSTALL_LIBDIR=lib .. 2>/dev/null \
                        && make -j"$(nproc)" 2>/dev/null; then
                        $SUDO make install 2>/dev/null
                        $SUDO ldconfig 2>/dev/null || true
                        ok "SatDump installed"
                    else
                        warn "SatDump build failed — weather satellite features will not be available"
                    fi
                fi
            ) || true
        else
            info "Skipping SatDump (weather satellite decoding will not be available)"
        fi
    else
        ok "SatDump already installed"
    fi

    # ---- DSD-FME (digital voice — optional) ----
    if ! have_any dsd dsd-fme; then
        echo
        info "DSD-FME decodes DMR, P25, NXDN, and D-STAR digital voice. Optional."
        if ask_yes_no "Build DSD-FME from source?" "n"; then
            install_build_deps
            apt_install_batch \
                libpulse-dev libfftw3-dev liblapack-dev libcodec2-dev \
                2>/dev/null || true
            (
                tmp_dir="$(mktemp -d)"
                trap 'rm -rf "$tmp_dir"' EXIT

                # Build mbelib first (required dependency)
                info "Building mbelib (vocoder library)..."
                if git clone --depth 1 https://github.com/lwvmobile/mbelib.git "$tmp_dir/mbelib" 2>/dev/null; then
                    cd "$tmp_dir/mbelib"
                    mkdir -p build && cd build
                    if cmake .. 2>/dev/null && make -j"$(nproc)" 2>/dev/null; then
                        $SUDO make install 2>/dev/null
                        $SUDO ldconfig 2>/dev/null || true
                        ok "mbelib installed"
                    else
                        warn "mbelib build failed — cannot build DSD"
                        exit 1
                    fi
                fi

                # Build DSD-FME
                info "Building DSD-FME..."
                if git clone --depth 1 https://github.com/lwvmobile/dsd-fme.git "$tmp_dir/dsd-fme" 2>/dev/null; then
                    cd "$tmp_dir/dsd-fme"
                    mkdir -p build && cd build
                    if cmake .. 2>/dev/null && make -j"$(nproc)" 2>/dev/null; then
                        $SUDO make install 2>/dev/null
                        $SUDO ldconfig 2>/dev/null || true
                        ok "DSD-FME installed"
                    else
                        warn "DSD-FME build failed — digital voice decoding will not be available"
                    fi
                fi
            ) || true
        else
            info "Skipping DSD-FME (digital voice decoding will not be available)"
        fi
    else
        ok "DSD already installed"
    fi

    # ---- rtlamr (utility meters — optional, requires Go) ----
    if ! cmd_exists rtlamr; then
        echo
        info "rtlamr reads utility smart meters (electric, gas, water). Optional."
        info "Requires Go to build from source."
        if ask_yes_no "Build rtlamr from source?" "n"; then
            # Check/install Go
            if ! cmd_exists go; then
                info "Installing Go compiler for rtlamr build..."
                apt_install_if_missing golang 2>/dev/null || {
                    warn "Go not available — cannot build rtlamr"
                }
            fi
            if cmd_exists go; then
                (
                    export GOPATH="${GOPATH:-/tmp/gopath-$$}"
                    export PATH="$GOPATH/bin:$PATH"
                    mkdir -p "$GOPATH/bin"

                    info "Building rtlamr..."
                    if go install github.com/bemasher/rtlamr@v0.9.4 2>/dev/null; then
                        $SUDO install -m 0755 "$GOPATH/bin/rtlamr" /usr/local/bin/rtlamr
                        ok "rtlamr installed"
                    else
                        warn "rtlamr build failed"
                    fi
                    rm -rf "$GOPATH" 2>/dev/null || true
                ) || true
            fi
        else
            info "Skipping rtlamr (utility meter reading will not be available)"
        fi
    else
        ok "rtlamr already installed"
    fi
fi

echo

# ==============================================================================
# Phase 5: System Configuration
# ==============================================================================
section "Phase 5: System Configuration"

# udev rules for RTL-SDR non-root access
setup_rtlsdr_udev

# Kernel driver blacklist (DVB-T conflicts with RTL-SDR)
echo
if $IS_JETSON; then
    info "Jetson platform: checking for DVB driver conflicts..."
fi
if ask_yes_no "Blacklist conflicting DVB kernel drivers for RTL-SDR?" "y"; then
    setup_rtlsdr_blacklist
else
    warn "Skipped kernel driver blacklist — RTL-SDR may not work if DVB drivers are loaded"
fi

# Create required data directories
info "Creating data directories..."
mkdir -p "${SCRIPT_DIR}/data/weather_sat"
mkdir -p "${SCRIPT_DIR}/instance"
ok "Data directories created"

# Download leaflet-heat plugin for offline mode
if [[ ! -f "${SCRIPT_DIR}/static/vendor/leaflet-heat/leaflet-heat.js" ]]; then
    info "Downloading leaflet-heat plugin for offline heatmap support..."
    mkdir -p "${SCRIPT_DIR}/static/vendor/leaflet-heat"
    if curl -sSfL "https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js" \
        -o "${SCRIPT_DIR}/static/vendor/leaflet-heat/leaflet-heat.js" 2>/dev/null; then
        ok "leaflet-heat plugin downloaded"
    else
        warn "Could not download leaflet-heat — heatmap will use CDN fallback"
    fi
else
    ok "leaflet-heat plugin already present"
fi

echo

# ==============================================================================
# Phase 6: Final Validation
# ==============================================================================
section "Phase 6: Final Validation"

# Audit all tools
audit_tools
print_tool_summary

# Validate Python imports
validate_python_imports "$VENV_PYTHON" || true

# Final port check
echo
check_port_available 5050 "VALENTINE RF web interface" || true

# Quick smoke test: can we import the app?
echo
info "Smoke test: importing application..."
if "$VENV_PYTHON" -c "
import sys
sys.path.insert(0, '${SCRIPT_DIR}')
from config import VERSION
print(f'VALENTINE RF v{VERSION}')
" 2>/dev/null; then
    ok "Application config loads successfully"
else
    warn "Application config import failed — check for missing dependencies"
fi

echo

# ==============================================================================
# Final Report
# ==============================================================================
section "Installation Complete"
echo
echo "  ┌──────────────────────────────────────────────────────┐"
echo "  │                  VALENTINE RF                        │"
echo "  │              Installation Summary                    │"
echo "  └──────────────────────────────────────────────────────┘"
echo
echo "  Python venv:  ${VENV_DIR}"
echo "  Python:       ${venv_py_ver}"
echo "  Platform:     ${DETECTED_OS} ${DETECTED_OS_VERSION} / ${DETECTED_ARCH}"
$IS_JETSON && echo "  Jetson:       ${JETSON_BOARD:-detected}"
echo

if [[ ${#MISSING_REQUIRED[@]} -gt 0 ]]; then
    echo -e "  ${RED}WARNING: ${#MISSING_REQUIRED[@]} required tool(s) are missing.${NC}"
    echo "  Some features will NOT work until these are installed."
    echo
fi

echo "  To start VALENTINE RF:"
echo
echo "    cd ${SCRIPT_DIR}"
echo "    sudo -E ${VENV_DIR}/bin/python valentine.py"
echo
echo "  Then open: http://localhost:5050"
echo
echo "  Environment variables (optional):"
echo "    VALENTINE_PORT=5050          Web interface port"
echo "    VALENTINE_SECRET_KEY=...     Session secret (set for production)"
echo "    VALENTINE_ADMIN_PASSWORD=... Admin password (set for production)"
echo "    VALENTINE_LOG_LEVEL=INFO     Log verbosity"
echo

# ==============================================================================
# Post-Install Checklist
# ==============================================================================
section "Post-Install Verification Checklist"
echo
echo "  Run these commands to verify the installation:"
echo
echo "  1. Activate the venv:"
echo "     source ${VENV_DIR}/bin/activate"
echo
echo "  2. Verify Python dependencies:"
echo "     python -c 'import quart; import httpx; import numpy; print(\"OK\")'"
echo
echo "  3. Check RTL-SDR device detection:"
echo "     rtl_test -t    (plug in an RTL-SDR first)"
echo
echo "  4. Start the application:"
echo "     sudo -E ${VENV_DIR}/bin/python valentine.py"
echo
echo "  5. Open in browser:"
echo "     http://localhost:5050"
echo
echo "  6. Run tests (optional):"
echo "     ${VENV_DIR}/bin/python -m pytest tests/"
echo

# Clear traps before clean exit
trap - ERR EXIT
exit 0
