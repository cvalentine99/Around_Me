/**
 * Geospatial View — Expandable multi-layer map intelligence view
 * Design: Obsidian Prism — full-viewport map with collapsible overlay panels
 *
 * This page faithfully represents all 5 Leaflet map instances in the codebase:
 *   1. ADS-B Aircraft Tracking (routes/adsb.py, adsb_dashboard.html)
 *   2. Meshtastic Mesh Network (routes/meshtastic.py, meshtastic.js)
 *   3. ISS / SSTV Tracking (routes/satellite.py, sstv.js)
 *   4. Weather Satellite Ground Track (routes/weather_sat.py, weather-satellite.js)
 *   5. WebSDR Receiver Map (routes/websdr.py, websdr.js)
 *
 * Plus: Trilateration engine (utils/trilateration.py) for WiFi/BT device location
 *       GPS integration (utils/gps.py) for observer position
 */
import { useState, useEffect, useRef, useCallback } from "react";
import {
  Plane,
  Radio,
  Satellite,
  CloudSun,
  Globe,
  MapPin,
  Crosshair,
  Layers,
  Maximize2,
  Minimize2,
  ChevronLeft,
  ChevronRight,
  Navigation,
  Target,
  Wifi,
  Bluetooth,
  Eye,
  EyeOff,
  LocateFixed,
  CircleDot,
  Radar as RadarIcon,
  Signal,
  Thermometer,
  Battery,
  ArrowUpRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MapLayer {
  id: string;
  label: string;
  icon: typeof Plane;
  color: string;
  enabled: boolean;
  count: number;
  poweredBy: string;
}

interface AircraftMarker {
  icao: string;
  callsign: string;
  lat: number;
  lon: number;
  altitude: number;
  speed: number;
  heading: number;
  trail: { lat: number; lon: number }[];
  lastSeen: string;
}

interface MeshNode {
  id: string;
  shortName: string;
  longName: string;
  lat: number;
  lon: number;
  altitude: number;
  role: "router" | "client" | "repeater" | "tracker";
  battery: number;
  snr: number;
  lastHeard: string;
  temp?: number;
  humidity?: number;
}

interface SatelliteTrack {
  name: string;
  type: "ISS" | "NOAA" | "METEOR";
  lat: number;
  lon: number;
  groundTrack: { lat: number; lon: number }[];
  nextPass?: string;
  elevation?: number;
}

interface WebSDRReceiver {
  name: string;
  lat: number;
  lon: number;
  antenna: string;
  users: number;
  available: boolean;
  freqRange: string;
}

interface TrilateratedDevice {
  id: string;
  type: "wifi" | "bluetooth";
  name: string;
  lat: number;
  lon: number;
  confidence: number;
  rssi: number;
  observations: number;
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

const mockAircraft: AircraftMarker[] = [
  {
    icao: "4CA87D", callsign: "RYR23KP", lat: 51.52, lon: -0.18, altitude: 37000,
    speed: 462, heading: 135,
    trail: [
      { lat: 51.58, lon: -0.35 }, { lat: 51.56, lon: -0.30 },
      { lat: 51.54, lon: -0.24 }, { lat: 51.52, lon: -0.18 },
    ],
    lastSeen: "1s",
  },
  {
    icao: "406A3B", callsign: "BAW156", lat: 51.47, lon: -0.46, altitude: 28500,
    speed: 380, heading: 270,
    trail: [
      { lat: 51.47, lon: -0.30 }, { lat: 51.47, lon: -0.35 },
      { lat: 51.47, lon: -0.40 }, { lat: 51.47, lon: -0.46 },
    ],
    lastSeen: "2s",
  },
  {
    icao: "3C4B12", callsign: "DLH4YA", lat: 51.38, lon: 0.08, altitude: 41000,
    speed: 498, heading: 90,
    trail: [
      { lat: 51.38, lon: -0.08 }, { lat: 51.38, lon: -0.02 },
      { lat: 51.38, lon: 0.03 }, { lat: 51.38, lon: 0.08 },
    ],
    lastSeen: "1s",
  },
  {
    icao: "A12B34", callsign: "UAL772", lat: 51.60, lon: 0.15, altitude: 35000,
    speed: 440, heading: 45,
    trail: [
      { lat: 51.55, lon: 0.05 }, { lat: 51.57, lon: 0.08 },
      { lat: 51.58, lon: 0.11 }, { lat: 51.60, lon: 0.15 },
    ],
    lastSeen: "3s",
  },
];

const mockMeshNodes: MeshNode[] = [
  { id: "!a1b2c3d4", shortName: "GW01", longName: "Gateway Alpha", lat: 51.505, lon: -0.09, altitude: 45, role: "router", battery: 92, snr: 12.5, lastHeard: "30s", temp: 22.3, humidity: 45 },
  { id: "!e5f6a7b8", shortName: "ND02", longName: "Node Bravo", lat: 51.51, lon: -0.12, altitude: 30, role: "client", battery: 67, snr: 8.2, lastHeard: "1m", temp: 21.8, humidity: 52 },
  { id: "!c9d0e1f2", shortName: "RP03", longName: "Repeater Charlie", lat: 51.49, lon: -0.07, altitude: 85, role: "repeater", battery: 100, snr: 15.1, lastHeard: "15s" },
  { id: "!a3b4c5d6", shortName: "TK04", longName: "Tracker Delta", lat: 51.515, lon: -0.15, altitude: 12, role: "tracker", battery: 34, snr: 5.8, lastHeard: "2m", temp: 23.1 },
  { id: "!e7f8a9b0", shortName: "ND05", longName: "Node Echo", lat: 51.495, lon: -0.05, altitude: 22, role: "client", battery: 88, snr: 10.3, lastHeard: "45s" },
];

const mockSatellites: SatelliteTrack[] = [
  {
    name: "ISS (ZARYA)", type: "ISS", lat: 51.42, lon: -0.30,
    groundTrack: Array.from({ length: 30 }, (_, i) => ({
      lat: 51.42 + Math.sin(i * 0.2) * 2,
      lon: -0.30 + i * 0.8,
    })),
    elevation: 408,
  },
  {
    name: "NOAA-19", type: "NOAA", lat: 52.0, lon: 2.5,
    groundTrack: Array.from({ length: 20 }, (_, i) => ({
      lat: 48 + i * 0.4,
      lon: 2.5 + Math.sin(i * 0.3) * 0.5,
    })),
    nextPass: "14:32 UTC",
    elevation: 870,
  },
  {
    name: "METEOR-M2-3", type: "METEOR", lat: 50.5, lon: -3.0,
    groundTrack: Array.from({ length: 20 }, (_, i) => ({
      lat: 46 + i * 0.45,
      lon: -3.0 + Math.sin(i * 0.25) * 0.8,
    })),
    nextPass: "16:05 UTC",
    elevation: 825,
  },
];

const mockReceivers: WebSDRReceiver[] = [
  { name: "Twente WebSDR", lat: 52.24, lon: 6.85, antenna: "Mini-Whip", users: 142, available: true, freqRange: "0-29 MHz" },
  { name: "KiwiSDR London", lat: 51.50, lon: -0.12, antenna: "Loop", users: 8, available: true, freqRange: "0-30 MHz" },
  { name: "KiwiSDR Tokyo", lat: 35.68, lon: 139.69, antenna: "Vertical", users: 23, available: true, freqRange: "0-30 MHz" },
  { name: "WebSDR Enschede", lat: 52.22, lon: 6.89, antenna: "Dipole", users: 0, available: false, freqRange: "0-29 MHz" },
];

const mockTrilaterated: TrilateratedDevice[] = [
  { id: "AA:BB:CC:01", type: "wifi", name: "NETGEAR-5G", lat: 51.508, lon: -0.095, confidence: 0.87, rssi: -42, observations: 12 },
  { id: "AA:BB:CC:02", type: "wifi", name: "Hidden Network", lat: 51.503, lon: -0.088, confidence: 0.62, rssi: -71, observations: 5 },
  { id: "11:22:33:01", type: "bluetooth", name: "AirPods Pro", lat: 51.506, lon: -0.092, confidence: 0.94, rssi: -35, observations: 18 },
  { id: "11:22:33:02", type: "bluetooth", name: "Unknown BLE", lat: 51.510, lon: -0.100, confidence: 0.45, rssi: -78, observations: 3 },
];

const OBSERVER = { lat: 51.505, lon: -0.09 };

// ─── Range Ring SVG Component ─────────────────────────────────────────────────

function RangeRings({ cx, cy, rings }: { cx: number; cy: number; rings: number[] }) {
  return (
    <g>
      {rings.map((r, i) => (
        <g key={i}>
          <circle
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke="oklch(0.7 0.18 285 / 0.12)"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
          <text
            x={cx + r + 3} y={cy - 3}
            fill="oklch(0.55 0.02 285)"
            fontSize="8"
            fontFamily="IBM Plex Mono, monospace"
          >
            {[5, 10, 25, 50][i] || ""}km
          </text>
        </g>
      ))}
    </g>
  );
}

// ─── Radar Sweep Overlay ──────────────────────────────────────────────────────

function RadarSweep({ cx, cy, radius }: { cx: number; cy: number; radius: number }) {
  const [angle, setAngle] = useState(0);

  useEffect(() => {
    let frame: number;
    const animate = () => {
      setAngle((a) => (a + 0.8) % 360);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, []);

  const rad = (angle * Math.PI) / 180;
  const endX = cx + Math.cos(rad) * radius;
  const endY = cy + Math.sin(rad) * radius;

  return (
    <g>
      <defs>
        <linearGradient id="sweepGrad" gradientUnits="userSpaceOnUse"
          x1={cx} y1={cy} x2={endX} y2={endY}>
          <stop offset="0%" stopColor="oklch(0.7 0.18 285 / 0)" />
          <stop offset="100%" stopColor="oklch(0.7 0.18 285 / 0.4)" />
        </linearGradient>
      </defs>
      <line
        x1={cx} y1={cy} x2={endX} y2={endY}
        stroke="url(#sweepGrad)" strokeWidth="2"
      />
      {/* Sweep trail arc */}
      <path
        d={describeArc(cx, cy, radius, angle - 30, angle)}
        fill="none"
        stroke="oklch(0.7 0.18 285 / 0.08)"
        strokeWidth={radius}
      />
    </g>
  );
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const s = ((startAngle - 90) * Math.PI) / 180;
  const e = ((endAngle - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(s);
  const y1 = cy + r * Math.sin(s);
  const x2 = cx + r * Math.cos(e);
  const y2 = cy + r * Math.sin(e);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}

// ─── Map Viewport ─────────────────────────────────────────────────────────────

function latLonToXY(
  lat: number, lon: number,
  center: { lat: number; lon: number },
  _zoom: number, width: number, height: number
) {
  // Scale so that ~0.6° lon spans ~half the viewport width
  const scale = Math.min(width, height) * 0.7;
  const x = width / 2 + (lon - center.lon) * scale;
  const y = height / 2 - (lat - center.lat) * scale * 1.6;
  return { x, y };
}

// ─── Layer Toggle Button ──────────────────────────────────────────────────────

function LayerToggle({
  layer,
  onToggle,
}: {
  layer: MapLayer;
  onToggle: () => void;
}) {
  const Icon = layer.icon;
  return (
    <button
      onClick={onToggle}
      className={cn(
        "flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-xs font-mono transition-all",
        layer.enabled
          ? "glass-card text-foreground"
          : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-accent/20"
      )}
    >
      <div className="relative">
        <Icon className="w-3.5 h-3.5" style={{ color: layer.enabled ? layer.color : undefined }} />
        {layer.enabled && (
          <div
            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
            style={{ background: layer.color }}
          />
        )}
      </div>
      <span className="flex-1 text-left truncate">{layer.label}</span>
      <span className={cn(
        "text-[10px] tabular-nums px-1.5 py-0.5 rounded",
        layer.enabled ? "bg-accent/50" : "bg-transparent"
      )}>
        {layer.count}
      </span>
      {layer.enabled ? (
        <Eye className="w-3 h-3 text-muted-foreground/60" />
      ) : (
        <EyeOff className="w-3 h-3 text-muted-foreground/30" />
      )}
    </button>
  );
}

// ─── Detail Drawer for selected entity ────────────────────────────────────────

function EntityDetail({
  entity,
  onClose,
}: {
  entity: {
    type: string;
    data: AircraftMarker | MeshNode | SatelliteTrack | WebSDRReceiver | TrilateratedDevice;
  } | null;
  onClose: () => void;
}) {
  if (!entity) return null;

  const renderContent = () => {
    switch (entity.type) {
      case "aircraft": {
        const ac = entity.data as AircraftMarker;
        return (
          <>
            <div className="flex items-center gap-2 mb-3">
              <Plane className="w-4 h-4 text-chart-5" style={{ transform: `rotate(${ac.heading}deg)` }} />
              <span className="font-display font-bold text-sm">{ac.callsign}</span>
              <span className="text-[10px] font-mono text-muted-foreground ml-auto">{ac.icao}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">ALTITUDE</div>
                <div className="text-foreground font-medium">{ac.altitude.toLocaleString()} ft</div>
              </div>
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">SPEED</div>
                <div className="text-foreground font-medium">{ac.speed} kts</div>
              </div>
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">HEADING</div>
                <div className="text-foreground font-medium">{ac.heading}°</div>
              </div>
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">POSITION</div>
                <div className="text-foreground font-medium">{ac.lat.toFixed(3)}°, {ac.lon.toFixed(3)}°</div>
              </div>
            </div>
            <div className="mt-3 text-[10px] font-mono text-muted-foreground/60">
              Trail: {ac.trail.length} points · Last seen: {ac.lastSeen}
            </div>
          </>
        );
      }
      case "mesh": {
        const node = entity.data as MeshNode;
        const roleColors: Record<string, string> = {
          router: "oklch(0.7 0.18 285)",
          client: "oklch(0.78 0.15 195)",
          repeater: "oklch(0.7 0.15 145)",
          tracker: "oklch(0.75 0.18 60)",
        };
        return (
          <>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold"
                style={{ background: `${roleColors[node.role]}20`, color: roleColors[node.role] }}>
                {node.shortName.slice(0, 2)}
              </div>
              <div>
                <div className="font-display font-bold text-sm">{node.longName}</div>
                <div className="text-[10px] font-mono text-muted-foreground">{node.id}</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">ROLE</div>
                <div className="font-medium capitalize" style={{ color: roleColors[node.role] }}>{node.role}</div>
              </div>
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">ALTITUDE</div>
                <div className="text-foreground font-medium">{node.altitude}m</div>
              </div>
              <div className="glass-card rounded px-2.5 py-2 flex items-center gap-1.5">
                <Battery className="w-3 h-3 text-muted-foreground" />
                <div>
                  <div className="text-muted-foreground text-[10px]">BATTERY</div>
                  <div className={cn("font-medium", node.battery > 50 ? "text-chart-4" : node.battery > 20 ? "text-chart-5" : "text-destructive")}>{node.battery}%</div>
                </div>
              </div>
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">SNR</div>
                <div className="text-foreground font-medium">{node.snr} dB</div>
              </div>
              {node.temp !== undefined && (
                <div className="glass-card rounded px-2.5 py-2 flex items-center gap-1.5">
                  <Thermometer className="w-3 h-3 text-muted-foreground" />
                  <div>
                    <div className="text-muted-foreground text-[10px]">TEMP</div>
                    <div className="text-foreground font-medium">{node.temp}°C</div>
                  </div>
                </div>
              )}
              {node.humidity !== undefined && (
                <div className="glass-card rounded px-2.5 py-2">
                  <div className="text-muted-foreground text-[10px]">HUMIDITY</div>
                  <div className="text-foreground font-medium">{node.humidity}%</div>
                </div>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" className="text-[10px] h-7 gap-1"
                onClick={() => toast("Traceroute initiated to " + node.shortName)}>
                <ArrowUpRight className="w-3 h-3" /> Traceroute
              </Button>
              <Button size="sm" variant="outline" className="text-[10px] h-7 gap-1"
                onClick={() => toast("Position request sent to " + node.shortName)}>
                <LocateFixed className="w-3 h-3" /> Req Position
              </Button>
            </div>
            <div className="mt-2 text-[10px] font-mono text-muted-foreground/60">
              Last heard: {node.lastHeard}
            </div>
          </>
        );
      }
      case "satellite": {
        const sat = entity.data as SatelliteTrack;
        return (
          <>
            <div className="flex items-center gap-2 mb-3">
              <Satellite className="w-4 h-4 text-chart-2" />
              <span className="font-display font-bold text-sm">{sat.name}</span>
              <span className={cn(
                "text-[10px] font-mono px-1.5 py-0.5 rounded ml-auto",
                sat.type === "ISS" ? "bg-chart-2/10 text-chart-2" :
                sat.type === "NOAA" ? "bg-chart-4/10 text-chart-4" :
                "bg-primary/10 text-primary"
              )}>{sat.type}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">POSITION</div>
                <div className="text-foreground font-medium">{sat.lat.toFixed(2)}°, {sat.lon.toFixed(2)}°</div>
              </div>
              {sat.elevation && (
                <div className="glass-card rounded px-2.5 py-2">
                  <div className="text-muted-foreground text-[10px]">ALTITUDE</div>
                  <div className="text-foreground font-medium">{sat.elevation} km</div>
                </div>
              )}
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">TRACK PTS</div>
                <div className="text-foreground font-medium">{sat.groundTrack.length}</div>
              </div>
              {sat.nextPass && (
                <div className="glass-card rounded px-2.5 py-2">
                  <div className="text-muted-foreground text-[10px]">NEXT PASS</div>
                  <div className="text-chart-2 font-medium">{sat.nextPass}</div>
                </div>
              )}
            </div>
          </>
        );
      }
      case "receiver": {
        const rx = entity.data as WebSDRReceiver;
        return (
          <>
            <div className="flex items-center gap-2 mb-3">
              <Globe className="w-4 h-4" style={{ color: rx.available ? "oklch(0.7 0.18 285)" : "oklch(0.4 0 0)" }} />
              <span className="font-display font-bold text-sm">{rx.name}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">ANTENNA</div>
                <div className="text-foreground font-medium">{rx.antenna}</div>
              </div>
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">USERS</div>
                <div className="text-foreground font-medium">{rx.users}</div>
              </div>
              <div className="glass-card rounded px-2.5 py-2 col-span-2">
                <div className="text-muted-foreground text-[10px]">FREQ RANGE</div>
                <div className="text-foreground font-medium">{rx.freqRange}</div>
              </div>
            </div>
            {rx.available && (
              <Button size="sm" className="w-full mt-3 text-xs h-8 gap-1.5"
                onClick={() => toast("Connecting to " + rx.name + "...")}>
                <Radio className="w-3 h-3" /> Listen
              </Button>
            )}
          </>
        );
      }
      case "trilaterated": {
        const dev = entity.data as TrilateratedDevice;
        return (
          <>
            <div className="flex items-center gap-2 mb-3">
              {dev.type === "wifi" ? <Wifi className="w-4 h-4 text-primary" /> : <Bluetooth className="w-4 h-4 text-chart-2" />}
              <span className="font-display font-bold text-sm">{dev.name}</span>
              <span className="text-[10px] font-mono text-muted-foreground ml-auto">{dev.id}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">CONFIDENCE</div>
                <div className={cn("font-medium", dev.confidence > 0.7 ? "text-chart-4" : dev.confidence > 0.4 ? "text-chart-5" : "text-destructive")}>
                  {(dev.confidence * 100).toFixed(0)}%
                </div>
              </div>
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">RSSI</div>
                <div className="text-foreground font-medium">{dev.rssi} dBm</div>
              </div>
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">OBSERVATIONS</div>
                <div className="text-foreground font-medium">{dev.observations}</div>
              </div>
              <div className="glass-card rounded px-2.5 py-2">
                <div className="text-muted-foreground text-[10px]">EST. POSITION</div>
                <div className="text-foreground font-medium">{dev.lat.toFixed(4)}°, {dev.lon.toFixed(4)}°</div>
              </div>
            </div>
            <div className="mt-2 text-[10px] font-mono text-muted-foreground/60">
              Powered by: utils/trilateration.py — PathLossModel + gradient descent
            </div>
          </>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="absolute bottom-4 left-4 w-80 glass-elevated rounded-lg z-30 animate-in slide-in-from-bottom-4 fade-in duration-200">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
        <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
          {entity.type} detail
        </span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs">
          ✕
        </button>
      </div>
      <div className="p-3">{renderContent()}</div>
    </div>
  );
}

// ─── Main Geospatial Page ─────────────────────────────────────────────────────

export default function GeospatialPage() {
  const [expanded, setExpanded] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showRadar, setShowRadar] = useState(true);
  const [selectedEntity, setSelectedEntity] = useState<{
    type: string;
    data: AircraftMarker | MeshNode | SatelliteTrack | WebSDRReceiver | TrilateratedDevice;
  } | null>(null);

  const mapRef = useRef<HTMLDivElement>(null);
  const [mapSize, setMapSize] = useState({ width: 1200, height: 700 });

  const [layers, setLayers] = useState<MapLayer[]>([
    { id: "adsb", label: "ADS-B Aircraft", icon: Plane, color: "oklch(0.75 0.18 60)", enabled: true, count: mockAircraft.length, poweredBy: "GET /adsb/stream (routes/adsb.py)" },
    { id: "mesh", label: "Meshtastic Mesh", icon: Radio, color: "oklch(0.7 0.18 285)", enabled: true, count: mockMeshNodes.length, poweredBy: "SSE /meshtastic/stream (routes/meshtastic.py)" },
    { id: "satellite", label: "Satellites", icon: Satellite, color: "oklch(0.78 0.15 195)", enabled: true, count: mockSatellites.length, poweredBy: "GET /satellite/iss-position (routes/satellite.py)" },
    { id: "websdr", label: "WebSDR Receivers", icon: Globe, color: "oklch(0.65 0.2 330)", enabled: false, count: mockReceivers.length, poweredBy: "GET /websdr/receivers (routes/websdr.py)" },
    { id: "trilateration", label: "Trilaterated Devices", icon: Target, color: "oklch(0.7 0.15 145)", enabled: true, count: mockTrilaterated.length, poweredBy: "utils/trilateration.py" },
  ]);

  const center = { lat: 51.505, lon: -0.09 };
  const zoom = 11;

  // Resize observer for the map container
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setMapSize({ width, height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const toggleLayer = useCallback((id: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, enabled: !l.enabled } : l))
    );
  }, []);

  const isLayerEnabled = (id: string) => layers.find((l) => l.id === id)?.enabled ?? false;

  const toXY = useCallback(
    (lat: number, lon: number) =>
      latLonToXY(lat, lon, center, zoom, mapSize.width, mapSize.height),
    [mapSize.width, mapSize.height]
  );

  // Keyboard shortcut: F for fullscreen toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "f" && !e.metaKey && !e.ctrlKey && !(e.target instanceof HTMLInputElement)) {
        setExpanded((v) => !v);
      }
      if (e.key === "Escape" && expanded) {
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [expanded]);

  const roleColors: Record<string, string> = {
    router: "oklch(0.7 0.18 285)",
    client: "oklch(0.78 0.15 195)",
    repeater: "oklch(0.7 0.15 145)",
    tracker: "oklch(0.75 0.18 60)",
  };

  return (
    <div className={cn(
      "flex flex-col transition-all duration-300",
      expanded
        ? "fixed inset-0 z-[100] bg-background"
        : "h-[calc(100vh-5rem)]"
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/30 bg-background/80 backdrop-blur-sm z-20">
        <div className="flex items-center gap-3">
          <MapPin className="w-4 h-4 text-primary" />
          <div>
            <h1 className="text-base font-display font-bold tracking-wide">Geospatial View</h1>
            <p className="text-[10px] font-mono text-muted-foreground">
              5 map layers · Trilateration · GPS observer
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline" size="sm"
            className="text-[10px] h-7 gap-1.5 font-mono"
            onClick={() => setShowRadar(!showRadar)}
          >
            <RadarIcon className="w-3 h-3" />
            {showRadar ? "Hide Radar" : "Show Radar"}
          </Button>
          <Button
            variant="outline" size="sm"
            className="text-[10px] h-7 gap-1.5 font-mono"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
            Layers
          </Button>
          <Button
            variant="outline" size="sm"
            className="text-[10px] h-7 gap-1.5 font-mono"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
            {expanded ? "Collapse" : "Expand"}
          </Button>
        </div>
      </div>

      {/* Main content: Map + Sidebar */}
      <div className="flex-1 flex min-h-0 relative">
        {/* Map viewport */}
        <div ref={mapRef} className="flex-1 relative overflow-hidden bg-[#06040a]">
          {/* Dark tile grid background */}
          <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
            <defs>
              <pattern id="mapGrid" width="60" height="60" patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="60" y2="0" stroke="oklch(0.65 0.18 285 / 0.06)" strokeWidth="0.5" />
                <line x1="0" y1="0" x2="0" y2="60" stroke="oklch(0.65 0.18 285 / 0.06)" strokeWidth="0.5" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#mapGrid)" />

            {/* Simulated coastline / terrain */}
            <path
              d={`M0,${mapSize.height * 0.55} Q${mapSize.width * 0.15},${mapSize.height * 0.5} ${mapSize.width * 0.25},${mapSize.height * 0.52} Q${mapSize.width * 0.35},${mapSize.height * 0.54} ${mapSize.width * 0.45},${mapSize.height * 0.48} Q${mapSize.width * 0.55},${mapSize.height * 0.42} ${mapSize.width * 0.65},${mapSize.height * 0.46} Q${mapSize.width * 0.75},${mapSize.height * 0.5} ${mapSize.width * 0.85},${mapSize.height * 0.44} Q${mapSize.width * 0.95},${mapSize.height * 0.38} ${mapSize.width},${mapSize.height * 0.42} L${mapSize.width},${mapSize.height} L0,${mapSize.height} Z`}
              fill="oklch(0.12 0.02 285 / 0.3)"
              stroke="oklch(0.65 0.18 285 / 0.1)"
              strokeWidth="1"
            />

            {/* Range rings from observer */}
            {(() => {
              const obs = toXY(OBSERVER.lat, OBSERVER.lon);
              const ringScale = Math.min(mapSize.width, mapSize.height) * 0.05;
              return <RangeRings cx={obs.x} cy={obs.y} rings={[ringScale, ringScale*2, ringScale*3.5, ringScale*5.5]} />;
            })()}

            {/* Radar sweep */}
            {showRadar && (() => {
              const obs = toXY(OBSERVER.lat, OBSERVER.lon);
              const sweepR = Math.min(mapSize.width, mapSize.height) * 0.3;
              return <RadarSweep cx={obs.x} cy={obs.y} radius={sweepR} />;
            })()}

            {/* Satellite ground tracks */}
            {isLayerEnabled("satellite") && mockSatellites.map((sat) => {
              const points = sat.groundTrack.map((p) => {
                const { x, y } = toXY(p.lat, p.lon);
                return `${x},${y}`;
              }).join(" ");
              const trackColor = sat.type === "ISS" ? "oklch(0.78 0.15 195)" :
                sat.type === "NOAA" ? "oklch(0.7 0.15 145)" : "oklch(0.7 0.18 285)";
              return (
                <polyline
                  key={sat.name}
                  points={points}
                  fill="none"
                  stroke={trackColor}
                  strokeWidth="1.5"
                  strokeDasharray="6 3"
                  opacity="0.6"
                />
              );
            })}

            {/* Aircraft trails */}
            {isLayerEnabled("adsb") && mockAircraft.map((ac) => {
              const points = ac.trail.map((p) => {
                const { x, y } = toXY(p.lat, p.lon);
                return `${x},${y}`;
              }).join(" ");
              return (
                <polyline
                  key={`trail-${ac.icao}`}
                  points={points}
                  fill="none"
                  stroke="oklch(0.75 0.18 60 / 0.4)"
                  strokeWidth="1.5"
                  strokeDasharray="4 2"
                />
              );
            })}

            {/* Mesh network links */}
            {isLayerEnabled("mesh") && mockMeshNodes.filter(n => n.role === "router" || n.role === "repeater").map((node) => {
              const from = toXY(node.lat, node.lon);
              return mockMeshNodes.filter(n => n.id !== node.id).slice(0, 2).map((target, i) => {
                const to = toXY(target.lat, target.lon);
                return (
                  <line
                    key={`link-${node.id}-${i}`}
                    x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                    stroke="oklch(0.7 0.18 285 / 0.15)"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                );
              });
            })}

            {/* Trilateration confidence circles */}
            {isLayerEnabled("trilateration") && mockTrilaterated.map((dev) => {
              const { x, y } = toXY(dev.lat, dev.lon);
              const radius = (1 - dev.confidence) * 40 + 8;
              return (
                <circle
                  key={`conf-${dev.id}`}
                  cx={x} cy={y} r={radius}
                  fill={dev.type === "wifi" ? "oklch(0.7 0.18 285 / 0.06)" : "oklch(0.78 0.15 195 / 0.06)"}
                  stroke={dev.type === "wifi" ? "oklch(0.7 0.18 285 / 0.2)" : "oklch(0.78 0.15 195 / 0.2)"}
                  strokeWidth="1"
                  strokeDasharray="3 2"
                />
              );
            })}
          </svg>

          {/* Observer marker */}
          {(() => {
            const { x, y } = toXY(OBSERVER.lat, OBSERVER.lon);
            return (
              <div className="absolute z-10" style={{ left: x - 8, top: y - 8 }}>
                <div className="relative">
                  <Crosshair className="w-4 h-4 text-chart-2" />
                  <div className="absolute w-6 h-6 -inset-1 rounded-full border border-chart-2/30 scan-pulse" />
                  <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[8px] font-mono text-chart-2 whitespace-nowrap">
                    OBSERVER
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Aircraft markers */}
          {isLayerEnabled("adsb") && mockAircraft.map((ac) => {
            const { x, y } = toXY(ac.lat, ac.lon);
            return (
              <button
                key={ac.icao}
                className="absolute z-10 group"
                style={{ left: x - 8, top: y - 8 }}
                onClick={() => setSelectedEntity({ type: "aircraft", data: ac })}
              >
                <Plane
                  className="w-4 h-4 text-chart-5 transition-transform group-hover:scale-125"
                  style={{ transform: `rotate(${ac.heading}deg)` }}
                />
                <div className="absolute -top-4 left-4 text-[8px] font-mono text-chart-5 whitespace-nowrap opacity-80 group-hover:opacity-100">
                  {ac.callsign}
                </div>
                <div className="absolute -bottom-3 left-4 text-[7px] font-mono text-muted-foreground whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
                  {ac.altitude.toLocaleString()}ft
                </div>
              </button>
            );
          })}

          {/* Mesh node markers */}
          {isLayerEnabled("mesh") && mockMeshNodes.map((node) => {
            const { x, y } = toXY(node.lat, node.lon);
            return (
              <button
                key={node.id}
                className="absolute z-10 group"
                style={{ left: x - 6, top: y - 6 }}
                onClick={() => setSelectedEntity({ type: "mesh", data: node })}
              >
                <div
                  className="w-3 h-3 rounded-sm border transition-transform group-hover:scale-150"
                  style={{
                    background: `${roleColors[node.role]}40`,
                    borderColor: roleColors[node.role],
                  }}
                />
                <div className="absolute -top-3 left-3 text-[7px] font-mono whitespace-nowrap opacity-70 group-hover:opacity-100 transition-opacity"
                  style={{ color: roleColors[node.role] }}>
                  {node.shortName}
                </div>
              </button>
            );
          })}

          {/* Satellite markers */}
          {isLayerEnabled("satellite") && mockSatellites.map((sat) => {
            const { x, y } = toXY(sat.lat, sat.lon);
            const color = sat.type === "ISS" ? "oklch(0.78 0.15 195)" :
              sat.type === "NOAA" ? "oklch(0.7 0.15 145)" : "oklch(0.7 0.18 285)";
            return (
              <button
                key={sat.name}
                className="absolute z-10 group"
                style={{ left: x - 8, top: y - 8 }}
                onClick={() => setSelectedEntity({ type: "satellite", data: sat })}
              >
                <Satellite className="w-4 h-4 transition-transform group-hover:scale-125" style={{ color }} />
                <div className="absolute -top-4 left-4 text-[8px] font-mono whitespace-nowrap opacity-80 group-hover:opacity-100" style={{ color }}>
                  {sat.name.split(" ")[0]}
                </div>
                {sat.type === "ISS" && (
                  <div className="absolute w-5 h-5 -inset-0.5 rounded-full pulse-live" style={{ boxShadow: `0 0 8px ${color}` }} />
                )}
              </button>
            );
          })}

          {/* WebSDR receiver markers */}
          {isLayerEnabled("websdr") && mockReceivers.map((rx) => {
            const { x, y } = toXY(rx.lat, rx.lon);
            return (
              <button
                key={rx.name}
                className="absolute z-10 group"
                style={{ left: x - 5, top: y - 5 }}
                onClick={() => setSelectedEntity({ type: "receiver", data: rx })}
              >
                <CircleDot
                  className="w-2.5 h-2.5 transition-transform group-hover:scale-150"
                  style={{ color: rx.available ? "oklch(0.65 0.2 330)" : "oklch(0.35 0 0)" }}
                />
                <div className="absolute -top-3 left-3 text-[7px] font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ color: rx.available ? "oklch(0.65 0.2 330)" : "oklch(0.4 0 0)" }}>
                  {rx.name}
                </div>
              </button>
            );
          })}

          {/* Trilaterated device markers */}
          {isLayerEnabled("trilateration") && mockTrilaterated.map((dev) => {
            const { x, y } = toXY(dev.lat, dev.lon);
            const color = dev.type === "wifi" ? "oklch(0.7 0.18 285)" : "oklch(0.78 0.15 195)";
            return (
              <button
                key={dev.id}
                className="absolute z-10 group"
                style={{ left: x - 5, top: y - 5 }}
                onClick={() => setSelectedEntity({ type: "trilaterated", data: dev })}
              >
                {dev.type === "wifi" ? (
                  <Wifi className="w-2.5 h-2.5 transition-transform group-hover:scale-150" style={{ color }} />
                ) : (
                  <Bluetooth className="w-2.5 h-2.5 transition-transform group-hover:scale-150" style={{ color }} />
                )}
                <div className="absolute -top-3 left-3 text-[7px] font-mono whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity" style={{ color }}>
                  {dev.name} ({(dev.confidence * 100).toFixed(0)}%)
                </div>
              </button>
            );
          })}

          {/* Coordinates overlay */}
          <div className="absolute bottom-3 left-3 text-[9px] font-mono text-muted-foreground/60 z-20">
            {OBSERVER.lat.toFixed(4)}°N, {Math.abs(OBSERVER.lon).toFixed(4)}°W · Zoom {zoom}
          </div>

          {/* Scale bar */}
          <div className="absolute bottom-3 right-3 flex items-end gap-1 z-20">
            <div className="w-16 h-px bg-muted-foreground/40" />
            <span className="text-[8px] font-mono text-muted-foreground/40">5 km</span>
          </div>

          {/* Entity detail drawer */}
          <EntityDetail
            entity={selectedEntity}
            onClose={() => setSelectedEntity(null)}
          />

          {/* Stats overlay */}
          <div className="absolute top-3 left-3 glass-panel rounded-lg px-3 py-2 z-20">
            <div className="flex items-center gap-4 text-[10px] font-mono">
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-chart-2 pulse-live" />
                <span className="text-chart-2">LIVE</span>
              </div>
              <span className="text-muted-foreground">
                {layers.filter(l => l.enabled).reduce((sum, l) => sum + l.count, 0)} entities tracked
              </span>
              <span className="text-muted-foreground">
                GPS: {OBSERVER.lat.toFixed(2)}°, {OBSERVER.lon.toFixed(2)}°
              </span>
            </div>
          </div>
        </div>

        {/* Layer sidebar */}
        <div className={cn(
          "border-l border-border/30 bg-background/80 backdrop-blur-sm transition-all duration-300 flex flex-col z-20",
          sidebarOpen ? "w-64" : "w-0 overflow-hidden"
        )}>
          <div className="px-3 py-3 border-b border-border/30">
            <div className="flex items-center gap-2 mb-1">
              <Layers className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-display font-bold tracking-wide">Map Layers</span>
            </div>
            <p className="text-[10px] font-mono text-muted-foreground">
              Toggle visibility per data source
            </p>
          </div>

          <div className="flex-1 overflow-auto p-2 space-y-1">
            {layers.map((layer) => (
              <LayerToggle
                key={layer.id}
                layer={layer}
                onToggle={() => toggleLayer(layer.id)}
              />
            ))}
          </div>

          {/* Observer info */}
          <div className="p-3 border-t border-border/30">
            <div className="glass-card rounded-lg p-2.5">
              <div className="flex items-center gap-2 mb-2">
                <Navigation className="w-3 h-3 text-chart-2" />
                <span className="text-[10px] font-mono font-medium text-foreground">Observer Position</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono">
                <div>
                  <span className="text-muted-foreground">LAT</span>
                  <div className="text-foreground">{OBSERVER.lat.toFixed(5)}°</div>
                </div>
                <div>
                  <span className="text-muted-foreground">LON</span>
                  <div className="text-foreground">{OBSERVER.lon.toFixed(5)}°</div>
                </div>
              </div>
              <div className="mt-2 text-[9px] font-mono text-muted-foreground/50">
                Powered by: utils/gps.py — GPSDClient
              </div>
            </div>
          </div>

          {/* Trilateration info */}
          <div className="p-3 pt-0">
            <div className="glass-card rounded-lg p-2.5">
              <div className="flex items-center gap-2 mb-2">
                <Signal className="w-3 h-3 text-chart-4" />
                <span className="text-[10px] font-mono font-medium text-foreground">Trilateration</span>
              </div>
              <div className="text-[10px] font-mono text-muted-foreground space-y-1">
                <div className="flex justify-between">
                  <span>WiFi devices</span>
                  <span className="text-foreground">{mockTrilaterated.filter(d => d.type === "wifi").length}</span>
                </div>
                <div className="flex justify-between">
                  <span>BT devices</span>
                  <span className="text-foreground">{mockTrilaterated.filter(d => d.type === "bluetooth").length}</span>
                </div>
                <div className="flex justify-between">
                  <span>Avg confidence</span>
                  <span className="text-chart-4">
                    {(mockTrilaterated.reduce((s, d) => s + d.confidence, 0) / mockTrilaterated.length * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
              <div className="mt-2 text-[9px] font-mono text-muted-foreground/50">
                PathLossModel + gradient descent optimization
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
