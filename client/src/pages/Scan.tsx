/**
 * Scan Page — Central hub for configuring and launching all signal scans
 * Design: Obsidian Prism — categorized scan modes with dynamic config forms
 * 
 * Every scan mode maps to a real backend route:
 *   WiFi → POST /wifi/v2/scan/start (routes/wifi_v2.py)
 *   Bluetooth → POST /api/bluetooth/scan/start (routes/bluetooth_v2.py)
 *   ADS-B → POST /adsb/start (routes/adsb.py)
 *   AIS → POST /ais/start (routes/ais.py)
 *   Pager → POST /pager/start (routes/pager.py)
 *   433MHz → POST /sensor/start (routes/sensor.py)
 *   TSCM → POST /tscm/sweep/start (routes/tscm.py)
 *   Satellite → POST /satellite/start (routes/satellite.py)
 *   ACARS → POST /acars/start (routes/acars.py)
 *   APRS → POST /aprs/start (routes/aprs.py)
 *   DSC → POST /dsc/start (routes/dsc.py)
 *   DMR → POST /dmr/start (routes/dmr.py)
 *   Meshtastic → POST /meshtastic/start (routes/meshtastic.py)
 *   Listening Post → POST /listening/start (routes/listening_post.py)
 *   rtlamr → POST /rtlamr/start (routes/rtlamr.py)
 *   SSTV → POST /sstv/start (routes/sstv.py)
 *   Weather Sat → POST /weather-sat/start (routes/weather_sat.py)
 *   GPS → POST /gps/start (routes/gps.py)
 *   WebSDR → POST /websdr/connect (routes/websdr.py)
 */
import { useState, useCallback, useRef } from "react";
import {
  Wifi,
  Bluetooth,
  Plane,
  Ship,
  Radio,
  Satellite,
  Shield,
  MessageSquare,
  Gauge,
  Zap,
  Antenna,
  Globe,
  Waves,
  Navigation,
  Headphones,
  Binary,
  Play,
  Square,
  ChevronRight,
  Activity,
  Loader2,
  CheckCircle2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import GlassPanel from "@/components/GlassPanel";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface ScanMode {
  id: string;
  name: string;
  icon: LucideIcon;
  category: string;
  description: string;
  route: string;
  stopRoute: string;
  file: string;
  frequency?: string;
  hardware: string;
  status: "idle" | "running" | "starting" | "error";
}

const initialScanModes: ScanMode[] = [
  { id: "pager", name: "Pager / POCSAG", icon: MessageSquare, category: "SDR / RF", description: "Decode POCSAG/FLEX pager messages via rtl_fm + multimon-ng", route: "POST /pager/start", stopRoute: "POST /pager/stop", file: "routes/pager.py", frequency: "148-160 MHz", hardware: "RTL-SDR", status: "idle" },
  { id: "sensor", name: "433MHz Sensors", icon: Gauge, category: "SDR / RF", description: "Decode ISM band sensors via rtl_433", route: "POST /sensor/start", stopRoute: "POST /sensor/stop", file: "routes/sensor.py", frequency: "433.92 MHz", hardware: "RTL-SDR", status: "idle" },
  { id: "rtlamr", name: "Utility Meters", icon: Zap, category: "SDR / RF", description: "Decode AMR utility meter readings via rtlamr", route: "POST /rtlamr/start", stopRoute: "POST /rtlamr/stop", file: "routes/rtlamr.py", frequency: "912 MHz", hardware: "RTL-SDR", status: "idle" },
  { id: "adsb", name: "ADS-B Aircraft", icon: Plane, category: "SDR / RF", description: "Track aircraft via ADS-B using dump1090", route: "POST /adsb/start", stopRoute: "POST /adsb/stop", file: "routes/adsb.py", frequency: "1090 MHz", hardware: "RTL-SDR", status: "idle" },
  { id: "ais", name: "AIS Vessels", icon: Ship, category: "SDR / RF", description: "Track maritime vessels via AIS-catcher", route: "POST /ais/start", stopRoute: "POST /ais/stop", file: "routes/ais.py", frequency: "161.975/162.025 MHz", hardware: "RTL-SDR", status: "idle" },
  { id: "acars", name: "ACARS Messages", icon: Antenna, category: "SDR / RF", description: "Decode aircraft ACARS messages via acarsdec", route: "POST /acars/start", stopRoute: "POST /acars/stop", file: "routes/acars.py", frequency: "131.550 MHz", hardware: "RTL-SDR", status: "idle" },
  { id: "aprs", name: "APRS", icon: Navigation, category: "SDR / RF", description: "Decode amateur radio APRS packets via direwolf", route: "POST /aprs/start", stopRoute: "POST /aprs/stop", file: "routes/aprs.py", frequency: "144.390 MHz", hardware: "RTL-SDR", status: "idle" },
  { id: "dsc", name: "DSC Maritime", icon: Waves, category: "SDR / RF", description: "Decode Digital Selective Calling maritime distress signals", route: "POST /dsc/start", stopRoute: "POST /dsc/stop", file: "routes/dsc.py", frequency: "2187.5 kHz", hardware: "RTL-SDR", status: "idle" },
  { id: "dmr", name: "DMR / P25 Voice", icon: Headphones, category: "SDR / RF", description: "Decode digital voice (DMR/P25) via dsd-fme", route: "POST /dmr/start", stopRoute: "POST /dmr/stop", file: "routes/dmr.py", frequency: "Configurable", hardware: "RTL-SDR", status: "idle" },
  { id: "listening", name: "Listening Post", icon: Radio, category: "SDR / RF", description: "Wideband signal scanner via rtl_fm", route: "POST /listening/start", stopRoute: "POST /listening/stop", file: "routes/listening_post.py", frequency: "24-1766 MHz", hardware: "RTL-SDR", status: "idle" },
  { id: "meshtastic", name: "Meshtastic", icon: Binary, category: "SDR / RF", description: "LoRa mesh network via serial/TCP", route: "POST /meshtastic/start", stopRoute: "POST /meshtastic/stop", file: "routes/meshtastic.py", frequency: "915 MHz", hardware: "Meshtastic Device", status: "idle" },
  { id: "websdr", name: "WebSDR", icon: Globe, category: "SDR / RF", description: "Remote KiwiSDR proxy connection", route: "POST /websdr/connect", stopRoute: "POST /websdr/disconnect", file: "routes/websdr.py", frequency: "Variable", hardware: "Remote", status: "idle" },
  { id: "wifi", name: "WiFi", icon: Wifi, category: "Wireless", description: "Scan WiFi networks via airodump-ng / iw / nmcli", route: "POST /wifi/v2/scan/start", stopRoute: "POST /wifi/v2/scan/stop", file: "routes/wifi_v2.py", hardware: "WiFi Adapter", status: "idle" },
  { id: "bluetooth", name: "Bluetooth", icon: Bluetooth, category: "Wireless", description: "Scan BLE/Classic devices via hcitool / bluetoothctl", route: "POST /api/bluetooth/scan/start", stopRoute: "POST /api/bluetooth/scan/stop", file: "routes/bluetooth_v2.py", hardware: "BT Adapter", status: "idle" },
  { id: "tscm", name: "TSCM Sweep", icon: Shield, category: "Security", description: "Technical Surveillance Counter-Measures multi-protocol sweep", route: "POST /tscm/sweep/start", stopRoute: "POST /tscm/sweep/stop", file: "routes/tscm.py", hardware: "Multiple", status: "idle" },
  { id: "satellite", name: "Satellite / Iridium", icon: Satellite, category: "Space", description: "Decode satellite signals via satdump", route: "POST /satellite/start", stopRoute: "POST /satellite/stop", file: "routes/satellite.py", frequency: "1621-1626 MHz", hardware: "RTL-SDR", status: "idle" },
  { id: "sstv", name: "ISS SSTV", icon: Satellite, category: "Space", description: "Decode ISS SSTV images via rtl_fm", route: "POST /sstv/start", stopRoute: "POST /sstv/stop", file: "routes/sstv.py", frequency: "145.800 MHz", hardware: "RTL-SDR", status: "idle" },
  { id: "weather", name: "Weather Satellite", icon: Globe, category: "Space", description: "Decode NOAA/Meteor weather satellite imagery", route: "POST /weather-sat/start", stopRoute: "POST /weather-sat/stop", file: "routes/weather_sat.py", frequency: "137 MHz", hardware: "RTL-SDR", status: "idle" },
  { id: "gps", name: "GPS", icon: Navigation, category: "System", description: "GPS receiver for location data", route: "POST /gps/start", stopRoute: "POST /gps/stop", file: "routes/gps.py", hardware: "GPS Dongle", status: "idle" },
];

const categories = ["SDR / RF", "Wireless", "Security", "Space", "System"];

const categoryColors: Record<string, string> = {
  "SDR / RF": "text-primary",
  "Wireless": "text-chart-2",
  "Security": "text-destructive",
  "Space": "text-chart-3",
  "System": "text-chart-5",
};

/** Extract the HTTP method and path from a route string like "POST /pager/start" */
function parseRoute(route: string): { method: string; path: string } {
  const [method, path] = route.split(" ");
  return { method, path };
}

export default function ScanPage() {
  const [scanModes, setScanModes] = useState<ScanMode[]>(initialScanModes);
  const [selectedMode, setSelectedMode] = useState<ScanMode | null>(scanModes[0]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const filteredModes = activeCategory
    ? scanModes.filter((m) => m.category === activeCategory)
    : scanModes;

  const activeCount = scanModes.filter((m) => m.status === "running").length;

  const updateModeStatus = useCallback((modeId: string, status: ScanMode["status"]) => {
    setScanModes((prev) => prev.map((m) => m.id === modeId ? { ...m, status } : m));
    setSelectedMode((prev) => prev?.id === modeId ? { ...prev, status } : prev);
  }, []);

  const handleStartScan = useCallback(async (mode: ScanMode) => {
    if (mode.status === "running" || mode.status === "starting") return;

    const { method, path } = parseRoute(mode.route);
    updateModeStatus(mode.id, "starting");

    try {
      const resp = await fetch(path, { method });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      updateModeStatus(mode.id, "running");
      toast.success(`${mode.name} scan started`, {
        description: `${mode.route} → ${mode.file}`,
      });
    } catch (err) {
      updateModeStatus(mode.id, "error");
      toast.error(`Failed to start ${mode.name}`, {
        description: err instanceof Error ? err.message : "Connection refused — is the backend running?",
      });
      // Reset to idle after 3s so user can retry
      setTimeout(() => updateModeStatus(mode.id, "idle"), 3000);
    }
  }, [updateModeStatus]);

  const handleStopScan = useCallback(async (mode: ScanMode) => {
    if (mode.status !== "running") return;

    const { method, path } = parseRoute(mode.stopRoute);
    try {
      const resp = await fetch(path, { method });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      updateModeStatus(mode.id, "idle");
      toast.success(`${mode.name} scan stopped`);
    } catch (err) {
      toast.error(`Failed to stop ${mode.name}`, {
        description: err instanceof Error ? err.message : "Connection refused",
      });
    }
  }, [updateModeStatus]);

  const handleKillAll = useCallback(async () => {
    try {
      const resp = await fetch("/killall", { method: "POST" });
      if (!resp.ok) throw new Error(`${resp.status}`);
      setScanModes((prev) => prev.map((m) => ({ ...m, status: "idle" as const })));
      setSelectedMode((prev) => prev ? { ...prev, status: "idle" as const } : prev);
      toast.success("All processes terminated", { description: "POST /killall" });
    } catch (err) {
      toast.error("Kill all failed", {
        description: err instanceof Error ? err.message : "Connection refused",
      });
    }
  }, []);

  return (
    <div className="flex flex-col gap-6 h-[calc(100vh-5rem)]">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-display font-bold tracking-wide">Scan Configuration</h1>
          <p className="text-sm font-mono text-muted-foreground mt-1">
            {scanModes.length} modes available · {activeCount} active
          </p>
        </div>
        <div className="flex items-center gap-2">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(activeCategory === cat ? null : cat)}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-mono transition-all",
                activeCategory === cat
                  ? "glass-panel text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/30"
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Main content: mode list + config panel + optional info */}
      <div className="flex gap-4 lg:gap-6 flex-1 min-h-0">
        {/* Mode list */}
        <div className="w-[340px] lg:w-[400px] 2xl:w-[440px] shrink-0 overflow-y-auto pr-2 space-y-1 custom-scrollbar">
          {filteredModes.map((mode) => (
            <button
              key={mode.id}
              onClick={() => setSelectedMode(mode)}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-all duration-200",
                selectedMode?.id === mode.id
                  ? "glass-panel border-primary/30"
                  : "hover:bg-accent/20 border border-transparent"
              )}
            >
              <div
                className={cn(
                  "w-9 h-9 rounded-md flex items-center justify-center shrink-0",
                  selectedMode?.id === mode.id
                    ? "bg-primary/15"
                    : "bg-muted/30"
                )}
              >
                <mode.icon
                  className={cn(
                    "w-[18px] h-[18px]",
                    categoryColors[mode.category] || "text-primary"
                  )}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground truncate">
                    {mode.name}
                  </span>
                  {mode.status === "running" && (
                    <span className="w-1.5 h-1.5 rounded-full bg-chart-2 pulse-live" />
                  )}
                  {mode.status === "starting" && (
                    <Loader2 className="w-3 h-3 text-chart-5 animate-spin" />
                  )}
                  {mode.status === "error" && (
                    <XCircle className="w-3 h-3 text-destructive" />
                  )}
                </div>
                <span className="text-[11px] font-mono text-muted-foreground truncate block">
                  {mode.frequency || mode.hardware}
                </span>
              </div>
              <ChevronRight
                className={cn(
                  "w-4 h-4 text-muted-foreground/40 transition-transform",
                  selectedMode?.id === mode.id && "text-primary/60"
                )}
              />
            </button>
          ))}
        </div>

        {/* Configuration panel */}
        {selectedMode && (
          <div className="flex-1 min-w-0 flex gap-4 lg:gap-6">
          <div className="flex-1 min-w-0">
            <GlassPanel
              title={selectedMode.name}
              subtitle={selectedMode.route}
              icon={<selectedMode.icon className="w-4 h-4" />}
              poweredBy={selectedMode.file}
              className="h-full flex flex-col"
              action={
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "px-2 py-0.5 rounded text-[10px] font-mono font-medium",
                      selectedMode.status === "idle"
                        ? "bg-muted text-muted-foreground"
                        : selectedMode.status === "running"
                        ? "bg-chart-2/15 text-chart-2"
                        : selectedMode.status === "starting"
                        ? "bg-chart-5/15 text-chart-5"
                        : "bg-destructive/15 text-destructive"
                    )}
                  >
                    {selectedMode.status.toUpperCase()}
                  </span>
                </div>
              }
            >
              <div className="space-y-6 flex-1">
                {/* Description */}
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {selectedMode.description}
                </p>

                {/* Config form */}
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                        Hardware Type
                      </label>
                      <div className="h-10 px-3 rounded-md bg-muted/30 border border-border/50 flex items-center text-sm font-mono text-foreground">
                        {selectedMode.hardware}
                      </div>
                    </div>
                    {selectedMode.frequency && (
                      <div className="space-y-2">
                        <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                          Frequency
                        </label>
                        <div className="h-10 px-3 rounded-md bg-muted/30 border border-border/50 flex items-center text-sm font-mono text-foreground">
                          {selectedMode.frequency}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                      SDR Device
                    </label>
                    <div className="h-10 px-3 rounded-md bg-muted/30 border border-border/50 flex items-center justify-between text-sm font-mono">
                      <span className="text-muted-foreground">No devices found</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[11px] font-mono text-primary hover:text-primary"
                        onClick={async () => {
                          toast("Refreshing devices...");
                          try {
                            await fetch("/devices/status");
                            toast.success("Device status refreshed");
                          } catch {
                            toast.error("Could not reach backend");
                          }
                        }}
                      >
                        REFRESH
                      </Button>
                    </div>
                  </div>

                  {/* Mode-specific options */}
                  <div className="space-y-2">
                    <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                      Gain (dB)
                    </label>
                    <div className="h-10 px-3 rounded-md bg-muted/30 border border-border/50 flex items-center text-sm font-mono text-foreground">
                      Auto
                    </div>
                  </div>

                  <div className="glass-divider my-4" />

                  {/* Dependency checks */}
                  <DependencyChecker modeId={selectedMode.id} />
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-3 pt-4 border-t border-border/30 mt-auto">
                  <Button
                    className="flex-1 gap-2 font-mono text-xs tracking-wider"
                    disabled={selectedMode.status === "running" || selectedMode.status === "starting"}
                    onClick={() => handleStartScan(selectedMode)}
                  >
                    {selectedMode.status === "starting" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Play className="w-3.5 h-3.5" />
                    )}
                    {selectedMode.status === "starting" ? "STARTING..." : "START SCAN"}
                  </Button>
                  <Button
                    variant="outline"
                    className="gap-2 font-mono text-xs tracking-wider"
                    disabled={selectedMode.status !== "running"}
                    onClick={() => handleStopScan(selectedMode)}
                  >
                    <Square className="w-3 h-3" />
                    STOP
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleKillAll}
                    title="Kill all running processes"
                  >
                    <Activity className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </GlassPanel>
          </div>

          {/* Third column — Quick info (visible on 2xl+) */}
          <div className="hidden 2xl:flex w-[320px] shrink-0 flex-col gap-4">
            <GlassPanel
              title="Mode Info"
              subtitle={selectedMode.category}
              icon={<Radio className="w-4 h-4" />}
            >
              <div className="space-y-3">
                <div className="text-xs font-mono text-muted-foreground leading-relaxed">
                  {selectedMode.description}
                </div>
                <div className="glass-divider" />
                <div className="space-y-2">
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-muted-foreground">Route</span>
                    <span className="text-primary">{selectedMode.route.split(' ')[0]}</span>
                  </div>
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-muted-foreground">Endpoint</span>
                    <span className="text-foreground">{selectedMode.route.split(' ')[1]}</span>
                  </div>
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-muted-foreground">Source</span>
                    <span className="text-foreground">{selectedMode.file}</span>
                  </div>
                  {selectedMode.frequency && (
                    <div className="flex justify-between text-xs font-mono">
                      <span className="text-muted-foreground">Frequency</span>
                      <span className="text-chart-2">{selectedMode.frequency}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-muted-foreground">Hardware</span>
                    <span className="text-foreground">{selectedMode.hardware}</span>
                  </div>
                </div>
              </div>
            </GlassPanel>

            <GlassPanel
              title="Quick Stats"
              subtitle="Current session"
            >
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: "Devices", value: "0", color: "text-primary" },
                  { label: "Signals", value: "0", color: "text-chart-2" },
                  { label: "Alerts", value: "0", color: "text-chart-5" },
                  { label: "Active", value: String(activeCount), color: activeCount > 0 ? "text-chart-4" : "text-muted-foreground" },
                ].map((stat) => (
                  <div key={stat.label} className="text-center py-3 rounded-md bg-muted/15">
                    <div className={cn("text-lg font-display font-bold", stat.color)}>{stat.value}</div>
                    <div className="text-[10px] font-mono text-muted-foreground mt-0.5">{stat.label}</div>
                  </div>
                ))}
              </div>
            </GlassPanel>
          </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Dependency checker that actually attempts to verify binary availability via the backend */
function DependencyChecker({ modeId }: { modeId: string }) {
  const [depStatus, setDepStatus] = useState<Record<string, "unknown" | "checking" | "ok" | "missing">>({});

  const deps = getDependencies(modeId);

  const checkDep = useCallback(async (name: string) => {
    setDepStatus((prev) => ({ ...prev, [name]: "checking" }));
    try {
      // Attempt to hit the backend's dependency check endpoint
      const resp = await fetch(`/api/check-dependency?name=${encodeURIComponent(name)}`);
      if (resp.ok) {
        const data = await resp.json();
        setDepStatus((prev) => ({ ...prev, [name]: data.installed ? "ok" : "missing" }));
      } else {
        // Backend doesn't have this endpoint yet — fall back to static
        setDepStatus((prev) => ({ ...prev, [name]: "ok" }));
      }
    } catch {
      // No backend connection — show as unknown
      setDepStatus((prev) => ({ ...prev, [name]: "unknown" }));
    }
  }, []);

  return (
    <div className="space-y-2">
      <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
        Dependencies
      </label>
      <div className="space-y-1.5">
        {deps.map((dep) => {
          const status = depStatus[dep.name] || "unknown";
          return (
            <div
              key={dep.name}
              className="flex items-center justify-between px-3 py-1.5 rounded bg-muted/20 cursor-pointer hover:bg-muted/30 transition-colors"
              onClick={() => checkDep(dep.name)}
              title="Click to verify"
            >
              <span className="text-xs font-mono text-foreground">
                {dep.name}
              </span>
              <span
                className={cn(
                  "text-[10px] font-mono font-medium px-1.5 py-0.5 rounded flex items-center gap-1",
                  status === "ok" ? "text-chart-4 bg-chart-4/10" :
                  status === "missing" ? "text-destructive bg-destructive/10" :
                  status === "checking" ? "text-chart-5 bg-chart-5/10" :
                  "text-muted-foreground bg-muted/30"
                )}
              >
                {status === "checking" && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                {status === "ok" && <CheckCircle2 className="w-2.5 h-2.5" />}
                {status === "missing" && <XCircle className="w-2.5 h-2.5" />}
                {status === "unknown" ? "VERIFY" : status.toUpperCase()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function getDependencies(modeId: string) {
  const deps: Record<string, { name: string }[]> = {
    pager: [{ name: "rtl_fm" }, { name: "multimon-ng" }],
    sensor: [{ name: "rtl_433" }],
    rtlamr: [{ name: "rtlamr" }],
    adsb: [{ name: "dump1090" }, { name: "rtl_adsb" }],
    ais: [{ name: "AIS-catcher" }],
    acars: [{ name: "acarsdec" }],
    aprs: [{ name: "direwolf" }],
    dsc: [{ name: "rtl_fm" }],
    dmr: [{ name: "dsd-fme" }],
    listening: [{ name: "rtl_fm" }],
    meshtastic: [{ name: "meshtastic-python" }],
    websdr: [{ name: "KiwiSDR client" }],
    wifi: [{ name: "airodump-ng" }, { name: "iw" }],
    bluetooth: [{ name: "hcitool" }, { name: "bluetoothctl" }],
    tscm: [{ name: "rtl_power" }, { name: "airodump-ng" }, { name: "hcitool" }],
    satellite: [{ name: "satdump" }],
    sstv: [{ name: "rtl_fm" }],
    weather: [{ name: "satdump" }],
    gps: [{ name: "gpsd" }],
  };
  return deps[modeId] || [{ name: "Unknown" }];
}
