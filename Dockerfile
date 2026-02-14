# VALENTINE RF - Around Me
# Docker container for running the web interface
#
# Security hardening:
#   - All git clones pinned to specific commits/tags
#   - Non-root USER directive (valentine:valentine)
#   - No privileged mode required — use targeted capabilities in docker-compose

FROM python:3.11-slim

LABEL maintainer="Valentine RF Project"
LABEL description="Signal Intelligence Platform for SDR monitoring"

# Set working directory
WORKDIR /app

# Pre-accept tshark non-root capture prompt for non-interactive install
RUN echo 'wireshark-common wireshark-common/install-setuid boolean true' | debconf-set-selections

# Install system dependencies for SDR tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    # RTL-SDR tools
    rtl-sdr \
    librtlsdr-dev \
    libusb-1.0-0-dev \
    # 433MHz decoder
    rtl-433 \
    # Pager decoder
    multimon-ng \
    # Audio tools for Listening Post
    ffmpeg \
    # SSTV decoder runtime libs
    libsndfile1 \
    # SatDump runtime libs (weather satellite decoding)
    libpng16-16 \
    libtiff6 \
    libjemalloc2 \
    libvolk-bin \
    libnng1 \
    libzstd1 \
    # WiFi tools (aircrack-ng suite)
    aircrack-ng \
    iw \
    wireless-tools \
    # Bluetooth tools
    bluez \
    bluetooth \
    # GPS support
    gpsd-clients \
    # APRS
    direwolf \
    # WiFi Extra
    hcxdumptool \
    hcxtools \
    # SDR Hardware & SoapySDR
    soapysdr-tools \
    soapysdr-module-rtlsdr \
    soapysdr-module-hackrf \
    soapysdr-module-lms7 \
    soapysdr-module-airspy \
    airspy \
    limesuite \
    hackrf \
    # Utilities
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

# ============================================================================
# Build from source — ALL git clones pinned to specific commits/tags
# ============================================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    pkg-config \
    cmake \
    libncurses-dev \
    libsndfile1-dev \
    libgtk-3-dev \
    libasound2-dev \
    libsoapysdr-dev \
    libhackrf-dev \
    liblimesuite-dev \
    libfftw3-dev \
    libpng-dev \
    libtiff-dev \
    libjemalloc-dev \
    libvolk-dev \
    libnng-dev \
    libzstd-dev \
    libsqlite3-dev \
    libcurl4-openssl-dev \
    zlib1g-dev \
    libzmq3-dev \
    libpulse-dev \
    liblapack-dev \
    libcodec2-dev \
    libboost-system-dev \
    libboost-program-options-dev \
    libboost-regex-dev \
    libboost-filesystem-dev \
    # ---- readsb (PREFERRED ADS-B decoder, pinned: 5831f91093ef) ----
    # readsb is the preferred decoder for all SDR types. It handles RTL-SDR
    # natively and supports SoapySDR for HackRF/LimeSDR/Airspy.
    && cd /tmp \
    && git clone https://github.com/wiedehopf/readsb.git \
    && cd readsb \
    && git checkout 5831f91093ef \
    && make BLADERF=no PLUTOSDR=no SOAPYSDR=yes \
    && cp readsb /usr/bin/readsb \
    && rm -rf /tmp/readsb \
    # ---- dump1090 (fallback for RTL-SDR, pinned: 4f47d12a18db) ----
    && cd /tmp \
    && git clone https://github.com/flightaware/dump1090.git \
    && cd dump1090 \
    && git checkout 4f47d12a18db \
    && sed -i 's/-Werror//g' Makefile \
    && make BLADERF=no RTLSDR=yes \
    && cp dump1090 /usr/bin/dump1090-fa \
    && ln -s /usr/bin/dump1090-fa /usr/bin/dump1090 \
    && rm -rf /tmp/dump1090 \
    # ---- dump978 (978 MHz UAT decoder, pinned: v9.0) ----
    # dump978 decodes UAT (978 MHz) ADS-B used by US GA below FL180.
    # Produces JSON via: dump978-fa --sdr | uat2json
    && cd /tmp \
    && git clone https://github.com/flightaware/dump978.git \
    && cd dump978 \
    && git checkout v9.0 \
    && mkdir build && cd build \
    && cmake .. -DCMAKE_INSTALL_PREFIX=/usr \
    && make -j$(nproc) \
    && cp dump978-fa /usr/bin/dump978-fa \
    && cp uat2json /usr/bin/uat2json \
    && cp uat2esnt /usr/bin/uat2esnt \
    && ln -sf /usr/bin/dump978-fa /usr/bin/dump978 \
    && rm -rf /tmp/dump978 \
    # ---- AIS-catcher (pinned: 5e34ea2363d5) ----
    && cd /tmp \
    && git clone https://github.com/jvde-github/AIS-catcher.git \
    && cd AIS-catcher \
    && git checkout 5e34ea2363d5 \
    && mkdir build && cd build \
    && cmake .. \
    && make \
    && cp AIS-catcher /usr/bin/AIS-catcher \
    && rm -rf /tmp/AIS-catcher \
    # ---- rx_tools (pinned: 811b21c4c8a5) ----
    && cd /tmp \
    && git clone https://github.com/rxseger/rx_tools.git \
    && cd rx_tools \
    && git checkout 811b21c4c8a5 \
    && mkdir build && cd build \
    && cmake .. \
    && make \
    && make install \
    && rm -rf /tmp/rx_tools \
    # ---- acarsdec (pinned: 339f63eb91a8) ----
    && cd /tmp \
    && git clone https://github.com/TLeconte/acarsdec.git \
    && cd acarsdec \
    && git checkout 339f63eb91a8 \
    && mkdir build && cd build \
    && cmake .. -Drtl=ON \
    && make \
    && cp acarsdec /usr/bin/acarsdec \
    && rm -rf /tmp/acarsdec \
    # slowrx removed — replaced by pure Python SSTV decoder (utils/sstv/) \
    # ---- SatDump (pinned: tag 1.2.2) ----
    && cd /tmp \
    && git clone --depth 1 --branch 1.2.2 https://github.com/SatDump/SatDump.git \
    && cd SatDump \
    && mkdir build && cd build \
    && cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_GUI=OFF -DCMAKE_INSTALL_LIBDIR=lib .. \
    && make -j$(nproc) \
    && make install \
    && ldconfig \
    && mkdir -p /usr/local/lib/satdump/plugins \
    && if [ -z "$(ls /usr/local/lib/satdump/plugins/*.so 2>/dev/null)" ]; then \
        for dir in /usr/local/lib/*/satdump/plugins /usr/lib/*/satdump/plugins /usr/lib/satdump/plugins; do \
            if [ -d "$dir" ] && [ -n "$(ls "$dir"/*.so 2>/dev/null)" ]; then \
                ln -sf "$dir"/*.so /usr/local/lib/satdump/plugins/; \
                break; \
            fi; \
        done; \
    fi \
    && rm -rf /tmp/SatDump \
    # ---- rtlamr (pinned: v0.9.4 via Go) ----
    && cd /tmp \
    && curl -fsSL "https://go.dev/dl/go1.22.5.linux-$(dpkg --print-architecture).tar.gz" | tar -C /usr/local -xz \
    && export PATH="$PATH:/usr/local/go/bin" \
    && export GOPATH=/tmp/gopath \
    && go install github.com/bemasher/rtlamr@v0.9.4 \
    && cp /tmp/gopath/bin/rtlamr /usr/bin/rtlamr \
    && rm -rf /usr/local/go /tmp/gopath \
    # ---- mbelib (pinned: 34adf9f054bc, branch ambe_tones) ----
    && cd /tmp \
    && git clone https://github.com/lwvmobile/mbelib.git \
    && cd mbelib \
    && git checkout 34adf9f054bc \
    && mkdir build && cd build \
    && cmake .. \
    && make -j$(nproc) \
    && make install \
    && ldconfig \
    && rm -rf /tmp/mbelib \
    # ---- DSD-FME (pinned: 615f67536f4b) ----
    && cd /tmp \
    && git clone https://github.com/lwvmobile/dsd-fme.git \
    && cd dsd-fme \
    && git checkout 615f67536f4b \
    && mkdir build && cd build \
    && cmake .. \
    && make -j$(nproc) \
    && make install \
    && ldconfig \
    && rm -rf /tmp/dsd-fme \
    # ---- Cleanup build tools ----
    && apt-get remove -y \
    build-essential \
    git \
    pkg-config \
    cmake \
    libncurses-dev \
    libsndfile1-dev \
    libgtk-3-dev \
    libasound2-dev \
    libpng-dev \
    libtiff-dev \
    libjemalloc-dev \
    libvolk-dev \
    libnng-dev \
    libzstd-dev \
    libsoapysdr-dev \
    libhackrf-dev \
    liblimesuite-dev \
    libsqlite3-dev \
    libcurl4-openssl-dev \
    zlib1g-dev \
    libzmq3-dev \
    libpulse-dev \
    libfftw3-dev \
    liblapack-dev \
    libcodec2-dev \
    libboost-system-dev \
    libboost-program-options-dev \
    libboost-regex-dev \
    libboost-filesystem-dev \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ============================================================================
# Create non-root user for runtime
# ============================================================================
RUN groupadd -r valentine && useradd -r -g valentine -d /app -s /sbin/nologin valentine

# Copy application code
COPY . .

# Create data directory for persistence and set ownership
RUN mkdir -p /app/data /app/data/weather_sat /app/instance \
    && chown -R valentine:valentine /app

# Expose web interface port
EXPOSE 5050

# Environment variables with defaults
ENV VALENTINE_HOST=0.0.0.0 \
    VALENTINE_PORT=5050 \
    VALENTINE_LOG_LEVEL=INFO \
    PYTHONUNBUFFERED=1

# Health check using the new endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:5050/health || exit 1

# Drop to non-root user
USER valentine

# Run the application
CMD ["python", "valentine.py"]
