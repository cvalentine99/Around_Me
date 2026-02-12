/**
 * Live View Page — Real-time monitoring dashboard with resizable panels
 * Design: Obsidian Prism — configurable grid of modular panels
 * 
 * Powered by SSE streams:
 *   WiFi → GET /wifi/v2/stream (routes/wifi_v2.py)
 *   Bluetooth → GET /api/bluetooth/stream (routes/bluetooth_v2.py)
 *   ADS-B → GET /adsb/stream (routes/adsb.py)
 *   AIS → GET /ais/stream (routes/ais.py)
 *   Pager → GET /pager/stream (routes/pager.py)
 *   Sensors → GET /sensor/stream (routes/sensor.py)
 *   TSCM → GET /tscm/sweep/stream (routes/tscm.py)
 *   Waterfall → WS /ws/waterfall
 *   Audio → WS /ws/audio
 */
import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import {
  Wifi,
  Bluetooth,
  Plane,
  MapPin,
  BarChart3,
  Layers,
  GripVertical,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import GlassPanel from "@/components/GlassPanel";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";

// ─── Simulated live data ───────────────────────────────────────────────────

interface WifiNetwork {
  bssid: string;
  ssid: string;
  channel: number;
  signal: number;
  security: string;
  clients: number;
  lastSeen: string;
}

interface BluetoothDevice {
  address: string;
  name: string;
  rssi: number;
  type: string;
  lastSeen: string;
}

interface Aircraft {
  icao: string;
  callsign: string;
  altitude: number;
  speed: number;
  heading: number;
  lat: number;
  lon: number;
  lastSeen: string;
}

const mockWifi: WifiNetwork[] = [
  { bssid: "AA:BB:CC:DD:EE:01", ssid: "NETGEAR-5G", channel: 36, signal: -42, security: "WPA3", clients: 8, lastSeen: "2s" },
  { bssid: "AA:BB:CC:DD:EE:02", ssid: "TP-Link_A7C2", channel: 6, signal: -58, security: "WPA2", clients: 3, lastSeen: "1s" },
  { bssid: "AA:BB:CC:DD:EE:03", ssid: "Hidden", channel: 11, signal: -71, security: "WPA2", clients: 0, lastSeen: "5s" },
  { bssid: "AA:BB:CC:DD:EE:04", ssid: "Starlink-2F8A", channel: 149, signal: -45, security: "WPA3", clients: 12, lastSeen: "1s" },
  { bssid: "AA:BB:CC:DD:EE:05", ssid: "BT-Hub6-K4PQ", channel: 1, signal: -63, security: "WPA2", clients: 5, lastSeen: "3s" },
];

const mockBluetooth: BluetoothDevice[] = [
  { address: "11:22:33:44:55:01", name: "AirPods Pro", rssi: -35, type: "BLE", lastSeen: "1s" },
  { address: "11:22:33:44:55:02", name: "Galaxy Watch5", rssi: -52, type: "BLE", lastSeen: "2s" },
  { address: "11:22:33:44:55:03", name: "Unknown", rssi: -78, type: "Classic", lastSeen: "8s" },
  { address: "11:22:33:44:55:04", name: "JBL Flip 6", rssi: -61, type: "Classic", lastSeen: "4s" },
];

const mockAircraft: Aircraft[] = [
  { icao: "4CA87D", callsign: "RYR23KP", altitude: 37000, speed: 462, heading: 135, lat: 51.47, lon: -0.46, lastSeen: "1s" },
  { icao: "406A3B", callsign: "BAW156", altitude: 28500, speed: 380, heading: 270, lat: 51.52, lon: -0.12, lastSeen: "2s" },
  { icao: "3C4B12", callsign: "DLH4YA", altitude: 41000, speed: 498, heading: 90, lat: 51.38, lon: 0.08, lastSeen: "1s" },
];

// ─── Shared Components ─────────────────────────────────────────────────────

function SignalBar({ value, max = -20, min = -90 }: { value: number; max?: number; min?: number }) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div className="w-16 h-1.5 rounded-full bg-muted/30 overflow-hidden">
      <div
        className={cn(
          "h-full rounded-full transition-all duration-500",
          pct > 70 ? "bg-chart-4" : pct > 40 ? "bg-chart-5" : "bg-destructive"
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Wrapper that makes any panel fill its resizable container */
function PanelContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("h-full flex flex-col overflow-hidden", className)}>
      {children}
    </div>
  );
}

// ─── Panel Components ──────────────────────────────────────────────────────

function WifiPanel() {
  return (
    <PanelContent>
      <GlassPanel
        title="WiFi Networks"
        subtitle={`${mockWifi.length} networks detected`}
        icon={<Wifi className="w-4 h-4" />}
        poweredBy="GET /wifi/v2/stream (routes/wifi_v2.py)"
        noPadding
        className="flex-1 flex flex-col"
      >
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 bg-card/90 backdrop-blur-sm z-10">
              <tr className="border-b border-border/30 text-muted-foreground">
                <th className="text-left px-4 py-2 font-medium">SSID</th>
                <th className="text-left px-4 py-2 font-medium">BSSID</th>
                <th className="text-center px-4 py-2 font-medium">CH</th>
                <th className="text-left px-4 py-2 font-medium">SIGNAL</th>
                <th className="text-left px-4 py-2 font-medium">SEC</th>
                <th className="text-center px-4 py-2 font-medium">CLI</th>
                <th className="text-right px-4 py-2 font-medium">SEEN</th>
              </tr>
            </thead>
            <tbody>
              {mockWifi.map((net) => (
                <tr
                  key={net.bssid}
                  className="border-b border-border/10 hover:bg-accent/20 transition-colors cursor-pointer"
                >
                  <td className="px-4 py-2.5 text-foreground font-medium">
                    {net.ssid === "Hidden" ? (
                      <span className="text-muted-foreground italic">Hidden</span>
                    ) : (
                      net.ssid
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{net.bssid}</td>
                  <td className="px-4 py-2.5 text-center text-foreground">{net.channel}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <SignalBar value={net.signal} />
                      <span className="text-muted-foreground">{net.signal}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        "px-1.5 py-0.5 rounded text-[10px] font-medium",
                        net.security === "WPA3"
                          ? "bg-chart-4/10 text-chart-4"
                          : net.security === "WPA2"
                          ? "bg-chart-5/10 text-chart-5"
                          : "bg-destructive/10 text-destructive"
                      )}
                    >
                      {net.security}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-center text-foreground">{net.clients}</td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">{net.lastSeen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassPanel>
    </PanelContent>
  );
}

function BluetoothPanel() {
  return (
    <PanelContent>
      <GlassPanel
        title="Bluetooth Devices"
        subtitle={`${mockBluetooth.length} devices detected`}
        icon={<Bluetooth className="w-4 h-4" />}
        poweredBy="GET /api/bluetooth/stream (routes/bluetooth_v2.py)"
        noPadding
        className="flex-1 flex flex-col"
      >
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 bg-card/90 backdrop-blur-sm z-10">
              <tr className="border-b border-border/30 text-muted-foreground">
                <th className="text-left px-4 py-2 font-medium">NAME</th>
                <th className="text-left px-4 py-2 font-medium">ADDRESS</th>
                <th className="text-left px-4 py-2 font-medium">RSSI</th>
                <th className="text-left px-4 py-2 font-medium">TYPE</th>
                <th className="text-right px-4 py-2 font-medium">SEEN</th>
              </tr>
            </thead>
            <tbody>
              {mockBluetooth.map((dev) => (
                <tr
                  key={dev.address}
                  className="border-b border-border/10 hover:bg-accent/20 transition-colors cursor-pointer"
                >
                  <td className="px-4 py-2.5 text-foreground font-medium">
                    {dev.name === "Unknown" ? (
                      <span className="text-muted-foreground italic">Unknown</span>
                    ) : (
                      dev.name
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{dev.address}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <SignalBar value={dev.rssi} />
                      <span className="text-muted-foreground">{dev.rssi}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        "px-1.5 py-0.5 rounded text-[10px] font-medium",
                        dev.type === "BLE"
                          ? "bg-primary/10 text-primary"
                          : "bg-chart-2/10 text-chart-2"
                      )}
                    >
                      {dev.type}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">{dev.lastSeen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassPanel>
    </PanelContent>
  );
}

function AircraftPanel() {
  return (
    <PanelContent>
      <GlassPanel
        title="ADS-B Aircraft"
        subtitle={`${mockAircraft.length} aircraft tracked`}
        icon={<Plane className="w-4 h-4" />}
        poweredBy="GET /adsb/stream (routes/adsb.py)"
        noPadding
        className="flex-1 flex flex-col"
      >
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 bg-card/90 backdrop-blur-sm z-10">
              <tr className="border-b border-border/30 text-muted-foreground">
                <th className="text-left px-4 py-2 font-medium">CALLSIGN</th>
                <th className="text-left px-4 py-2 font-medium">ICAO</th>
                <th className="text-right px-4 py-2 font-medium">ALT</th>
                <th className="text-right px-4 py-2 font-medium">SPD</th>
                <th className="text-right px-4 py-2 font-medium">HDG</th>
                <th className="text-right px-4 py-2 font-medium">SEEN</th>
              </tr>
            </thead>
            <tbody>
              {mockAircraft.map((ac) => (
                <tr
                  key={ac.icao}
                  className="border-b border-border/10 hover:bg-accent/20 transition-colors cursor-pointer"
                >
                  <td className="px-4 py-2.5 text-foreground font-medium">{ac.callsign}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{ac.icao}</td>
                  <td className="px-4 py-2.5 text-right text-foreground">{ac.altitude.toLocaleString()} ft</td>
                  <td className="px-4 py-2.5 text-right text-foreground">{ac.speed} kts</td>
                  <td className="px-4 py-2.5 text-right text-foreground">{ac.heading}°</td>
                  <td className="px-4 py-2.5 text-right text-muted-foreground">{ac.lastSeen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassPanel>
    </PanelContent>
  );
}

/**
 * BLOCKER 3 FIX: Waterfall canvas rewritten to avoid getImageData per frame.
 * Uses drawImage(canvas, ...) for the scroll shift instead of allocating ~18MB/frame.
 * Resize uses setTransform() to prevent compounding scale.
 * ResizeObserver is debounced to prevent mid-animation canvas clearing.
 */
function WaterfallPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let resizeTimer: ReturnType<typeof setTimeout>;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      // Save current content to an offscreen canvas before resizing
      const offscreen = document.createElement("canvas");
      offscreen.width = canvas.width;
      offscreen.height = canvas.height;
      const offCtx = offscreen.getContext("2d");
      if (offCtx && canvas.width > 0 && canvas.height > 0) {
        offCtx.drawImage(canvas, 0, 0);
      }
      canvas.width = rect.width * 2;
      canvas.height = rect.height * 2;
      // Reset transform then apply 2x scale (prevents compounding)
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      // Restore content
      if (offscreen.width > 0 && offscreen.height > 0) {
        ctx.drawImage(offscreen, 0, 0, offscreen.width / 2, offscreen.height / 2);
      }
    };

    const debouncedResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 100);
    };

    resize();
    const observer = new ResizeObserver(debouncedResize);
    observer.observe(container);

    let animFrame: number;
    let offset = 0;

    const draw = () => {
      const w = container.offsetWidth;
      const h = container.offsetHeight;
      if (w === 0 || h === 0) {
        animFrame = requestAnimationFrame(draw);
        return;
      }

      // Shift existing content down by 1px using drawImage (no getImageData allocation)
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 2, canvas.width, canvas.height);

      // Draw new line at top
      for (let x = 0; x < w; x++) {
        const freq = x / w;
        const noise = Math.random() * 0.3;
        const peak1 = Math.exp(-Math.pow((freq - 0.25) * 20, 2)) * 0.8;
        const peak2 = Math.exp(-Math.pow((freq - 0.6) * 15, 2)) * 0.5;
        const peak3 = Math.exp(-Math.pow((freq - 0.85 + Math.sin(offset * 0.02) * 0.05) * 25, 2)) * 0.6;
        const val = Math.min(1, noise + peak1 + peak2 + peak3);

        const r = Math.floor(val * 139);
        const g = Math.floor(val * 92 + val * val * 164);
        const b = Math.floor(val * 246);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(x, 0, 1, 1);
      }

      offset++;
      animFrame = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      cancelAnimationFrame(animFrame);
      clearTimeout(resizeTimer);
      observer.disconnect();
    };
  }, []);

  return (
    <PanelContent>
      <GlassPanel
        title="Waterfall Display"
        subtitle="Real-time FFT visualization"
        icon={<BarChart3 className="w-4 h-4" />}
        poweredBy="WS /ws/waterfall"
        noPadding
        className="flex-1 flex flex-col"
      >
        <div ref={containerRef} className="flex-1 relative min-h-[120px]">
          <canvas ref={canvasRef} className="w-full h-full" />
          <div className="absolute bottom-2 left-3 right-3 flex justify-between text-[9px] font-mono text-muted-foreground/60">
            <span>24 MHz</span>
            <span>900 MHz</span>
            <span>1766 MHz</span>
          </div>
        </div>
      </GlassPanel>
    </PanelContent>
  );
}

function MapPanel() {
  return (
    <PanelContent>
      <GlassPanel
        title="Geospatial View"
        subtitle="Aircraft & vessel positions"
        icon={<MapPin className="w-4 h-4" />}
        poweredBy="Leaflet.js + /adsb/stream, /ais/stream"
        noPadding
        className="flex-1 flex flex-col"
      >
        <div className="flex-1 bg-[#08060e] relative overflow-hidden rounded-b-lg min-h-[180px]">
          {/* Simulated dark map */}
          <div className="absolute inset-0 opacity-30">
            <svg viewBox="0 0 800 400" className="w-full h-full" preserveAspectRatio="none">
              {Array.from({ length: 20 }).map((_, i) => (
                <line
                  key={`h${i}`}
                  x1="0" y1={i * 20} x2="800" y2={i * 20}
                  stroke="oklch(0.65 0.18 285 / 0.1)" strokeWidth="0.5"
                />
              ))}
              {Array.from({ length: 40 }).map((_, i) => (
                <line
                  key={`v${i}`}
                  x1={i * 20} y1="0" x2={i * 20} y2="400"
                  stroke="oklch(0.65 0.18 285 / 0.1)" strokeWidth="0.5"
                />
              ))}
              <path
                d="M0,200 Q100,180 200,190 Q300,200 350,170 Q400,140 450,160 Q500,180 550,150 Q600,120 700,140 Q750,150 800,130"
                fill="none" stroke="oklch(0.65 0.18 285 / 0.3)" strokeWidth="1"
              />
            </svg>
          </div>

          {mockAircraft.map((ac, i) => (
            <div
              key={ac.icao}
              className="absolute"
              style={{ left: `${20 + i * 30}%`, top: `${30 + i * 15}%` }}
            >
              <div className="relative group">
                <Plane
                  className="w-4 h-4 text-chart-5 transform"
                  style={{ transform: `rotate(${ac.heading}deg)` }}
                />
                <div className="absolute -top-5 left-4 text-[9px] font-mono text-chart-5 whitespace-nowrap opacity-80">
                  {ac.callsign}
                </div>
                <div className="absolute w-2 h-2 -inset-0.5 rounded-full bg-chart-5/20 scan-pulse" />
              </div>
            </div>
          ))}

          <div className="absolute bottom-3 right-3 text-[9px] font-mono text-muted-foreground/60">
            51.47°N, 0.46°W
          </div>
        </div>
      </GlassPanel>
    </PanelContent>
  );
}

// ─── Custom Resize Handle ──────────────────────────────────────────────────

function CustomResizeHandle({ direction = "horizontal" }: { direction?: "horizontal" | "vertical" }) {
  return (
    <ResizableHandle
      className={cn(
        "group relative",
        direction === "horizontal"
          ? "w-2 bg-transparent hover:bg-primary/10 transition-colors mx-0.5"
          : "h-2 bg-transparent hover:bg-primary/10 transition-colors my-0.5"
      )}
    >
      <div className={cn(
        "absolute rounded-full bg-border/40 group-hover:bg-primary/50 transition-all",
        direction === "horizontal"
          ? "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[3px] h-8 group-hover:h-12"
          : "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[3px] w-8 group-hover:w-12"
      )} />
    </ResizableHandle>
  );
}

// ─── Status Bar (FIX 2.1: uptime now counts from session start) ───────────

function StatusBar() {
  const startTime = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const formatUptime = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  return (
    <div className="flex items-center gap-4 px-4 py-2 glass-panel rounded-lg text-xs font-mono">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-chart-2 pulse-live" />
        <span className="text-chart-2">LIVE</span>
      </div>
      <div className="w-px h-4" style={{ background: 'oklch(0.65 0.18 285 / 0.2)' }} />
      <span className="text-muted-foreground">
        WiFi: {mockWifi.length} · BT: {mockBluetooth.length} · Aircraft: {mockAircraft.length}
      </span>
      <div className="ml-auto flex items-center gap-3 text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <GripVertical className="w-3 h-3 text-primary/40" />
          <span className="text-[10px]">Drag borders to resize</span>
        </span>
        <span>Uptime: {formatUptime(elapsed)}</span>
      </div>
    </div>
  );
}

// ─── Layout Presets ────────────────────────────────────────────────────────

type LayoutPreset = "default" | "wide-wifi" | "map-focus" | "waterfall";

const layoutPresets: { id: LayoutPreset; label: string; description: string }[] = [
  { id: "default", label: "Balanced", description: "Equal panel distribution" },
  { id: "wide-wifi", label: "WiFi Focus", description: "Expanded WiFi panel" },
  { id: "map-focus", label: "Map Focus", description: "Large geospatial view" },
  { id: "waterfall", label: "Spectrum", description: "Full-width waterfall" },
];

// ─── Main Export ───────────────────────────────────────────────────────────

export default function LiveViewPage() {
  const [layout, setLayout] = useState<LayoutPreset>("default");
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  /**
   * FIX LOGIC 3.3: Use a key to force remount of ResizablePanelGroup
   * when layout changes, since defaultSize is only read on mount.
   */
  const [layoutKey, setLayoutKey] = useState(0);

  const changeLayout = useCallback((preset: LayoutPreset) => {
    setLayout(preset);
    setLayoutKey((k) => k + 1); // Force remount
    setShowLayoutMenu(false);
  }, []);

  // FIX EDGE 5.2: Close layout dropdown on Escape key
  useEffect(() => {
    if (!showLayoutMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowLayoutMenu(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showLayoutMenu]);

  // Panel size defaults per layout
  const getTopRowSizes = () => {
    switch (layout) {
      case "wide-wifi": return { left: 70, right: 30 };
      case "map-focus": return { left: 40, right: 60 };
      default: return { left: 55, right: 45 };
    }
  };

  const getBottomRowSizes = () => {
    switch (layout) {
      case "waterfall": return { left: 50, middle: 25, right: 25 };
      case "map-focus": return { left: 30, middle: 40, right: 30 };
      default: return { left: 33, middle: 34, right: 33 };
    }
  };

  const getVerticalSplit = () => {
    switch (layout) {
      case "waterfall": return { top: 40, bottom: 60 };
      default: return { top: 55, bottom: 45 };
    }
  };

  const topSizes = getTopRowSizes();
  const bottomSizes = getBottomRowSizes();
  const verticalSplit = getVerticalSplit();

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-5rem)]">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-display font-bold tracking-wide">Live View</h1>
          <p className="text-sm font-mono text-muted-foreground mt-1">
            Real-time signal monitoring dashboard
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-xs font-mono"
              onClick={() => setShowLayoutMenu(!showLayoutMenu)}
            >
              <Layers className="w-3 h-3" />
              Layout: {layoutPresets.find(l => l.id === layout)?.label}
            </Button>
            {showLayoutMenu && (
              <div className="absolute right-0 top-full mt-1 z-[60] w-52 glass-elevated rounded-lg p-1 animate-in fade-in slide-in-from-top-2 duration-200">
                {layoutPresets.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => changeLayout(preset.id)}
                    className={cn(
                      "w-full text-left px-3 py-2 rounded-md text-xs font-mono transition-all",
                      layout === preset.id
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                    )}
                  >
                    <div className="font-medium">{preset.label}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{preset.description}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 text-xs font-mono"
            onClick={() => { changeLayout("default"); toast("Layout reset to default"); }}
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </Button>
        </div>
      </div>

      {/* Status bar */}
      <StatusBar />

      {/* Resizable panel grid — key forces remount on layout change (FIX 3.3) */}
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup
          key={`layout-${layoutKey}`}
          direction="vertical"
          className="h-full"
        >
          {/* Top row: WiFi + Bluetooth */}
          <ResizablePanel
            defaultSize={verticalSplit.top}
            minSize={25}
            className="flex"
          >
            <ResizablePanelGroup direction="horizontal">
              <ResizablePanel
                defaultSize={topSizes.left}
                minSize={25}
              >
                <WifiPanel />
              </ResizablePanel>

              <CustomResizeHandle direction="horizontal" />

              <ResizablePanel
                defaultSize={topSizes.right}
                minSize={20}
              >
                <BluetoothPanel />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>

          <CustomResizeHandle direction="vertical" />

          {/* Bottom row: Map + Waterfall + ADS-B */}
          <ResizablePanel
            defaultSize={verticalSplit.bottom}
            minSize={25}
            className="flex"
          >
            <ResizablePanelGroup direction="horizontal">
              <ResizablePanel
                defaultSize={bottomSizes.left}
                minSize={15}
              >
                <MapPanel />
              </ResizablePanel>

              <CustomResizeHandle direction="horizontal" />

              <ResizablePanel
                defaultSize={bottomSizes.middle}
                minSize={15}
              >
                <WaterfallPanel />
              </ResizablePanel>

              <CustomResizeHandle direction="horizontal" />

              <ResizablePanel
                defaultSize={bottomSizes.right}
                minSize={15}
              >
                <AircraftPanel />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* Close layout menu on outside click — z-index above header (FIX 5.2) */}
      {showLayoutMenu && (
        <div
          className="fixed inset-0 z-[55]"
          onClick={() => setShowLayoutMenu(false)}
        />
      )}
    </div>
  );
}
