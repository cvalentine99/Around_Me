/**
 * History Page — Past scan sessions, recordings, and TSCM reports
 * Design: Obsidian Prism — timeline with expandable session cards
 * 
 * Powered by:
 *   Recordings → recording_sessions table (routes/recordings.py)
 *   TSCM Reports → tscm_sweeps, tscm_cases tables (routes/tscm.py)
 *   Signal History → signal_history table (utils/database.py)
 *   Export → GET /recordings/export (routes/recordings.py)
 */
import { useState, useMemo, useRef, useEffect } from "react";
import {
  Clock,
  FileText,
  Download,
  Play,
  Shield,
  Wifi,
  Bluetooth,
  Plane,
  Radio,
  ChevronRight,
  ChevronDown,
  Calendar,
  HardDrive,
  Trash2,
  MapPin,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Eye,
  Activity,
  Zap,
  Signal,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import GlassPanel from "@/components/GlassPanel";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// ─── Recording types ───────────────────────────────────────────────────────

interface Session {
  id: string;
  type: string;
  icon: typeof Radio;
  startTime: string;
  endTime: string;
  duration: string;
  date: string;
  deviceCount: number;
  signalCount: number;
  fileSize: string;
  status: "complete" | "partial" | "error";
  poweredBy: string;
}

// ─── TSCM types ────────────────────────────────────────────────────────────

type ThreatLevel = "clear" | "suspicious" | "compromised";

interface TSCMSweepPoint {
  time: string;
  wifi: number;
  bluetooth: number;
  rf: number;
  gsm: number;
  anomalyScore: number;
}

interface TSCMThreat {
  id: string;
  type: string;
  protocol: string;
  frequency: string;
  signalStrength: number;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "active" | "resolved" | "monitoring";
}

interface TSCMReport {
  id: string;
  caseName: string;
  sweepDate: string;
  location: string;
  threatLevel: ThreatLevel;
  threatsFound: number;
  protocols: string[];
  poweredBy: string;
  analyst: string;
  duration: string;
  roomSize: string;
  baselineDeviation: number;
  sweepData: TSCMSweepPoint[];
  threats: TSCMThreat[];
  protocolCoverage: { protocol: string; scanned: boolean; anomalies: number; devices: number }[];
  notes: string;
}

// ─── Mock data ─────────────────────────────────────────────────────────────

const mockSessions: Session[] = [
  { id: "rec1", type: "WiFi Scan", icon: Wifi, startTime: "14:00:00", endTime: "14:45:00", duration: "45m", date: "2026-02-10", deviceCount: 23, signalCount: 1847, fileSize: "12.4 MB", status: "complete", poweredBy: "routes/recordings.py" },
  { id: "rec2", type: "ADS-B Track", icon: Plane, startTime: "12:00:00", endTime: "14:00:00", duration: "2h", date: "2026-02-10", deviceCount: 156, signalCount: 24500, fileSize: "48.2 MB", status: "complete", poweredBy: "routes/recordings.py" },
  { id: "rec3", type: "Bluetooth Scan", icon: Bluetooth, startTime: "10:30:00", endTime: "11:15:00", duration: "45m", date: "2026-02-10", deviceCount: 34, signalCount: 890, fileSize: "5.1 MB", status: "complete", poweredBy: "routes/recordings.py" },
  { id: "rec4", type: "Pager Decode", icon: Radio, startTime: "09:00:00", endTime: "10:00:00", duration: "1h", date: "2026-02-09", deviceCount: 0, signalCount: 312, fileSize: "2.8 MB", status: "complete", poweredBy: "routes/recordings.py" },
  { id: "rec5", type: "WiFi + BT Sweep", icon: Wifi, startTime: "16:00:00", endTime: "16:22:00", duration: "22m", date: "2026-02-09", deviceCount: 18, signalCount: 456, fileSize: "3.2 MB", status: "partial", poweredBy: "routes/recordings.py" },
];

function generateSweepData(): TSCMSweepPoint[] {
  const points: TSCMSweepPoint[] = [];
  for (let i = 0; i < 24; i++) {
    const h = String(i).padStart(2, "0");
    points.push({
      time: `${h}:00`,
      wifi: Math.floor(3 + Math.random() * 8),
      bluetooth: Math.floor(1 + Math.random() * 6),
      rf: Math.floor(Math.random() * 3),
      gsm: Math.floor(Math.random() * 2),
      anomalyScore: Math.random() * (i === 14 || i === 15 ? 0.9 : 0.3),
    });
  }
  return points;
}

const mockTSCM: TSCMReport[] = [
  {
    id: "tscm1",
    caseName: "Conference Room Alpha",
    sweepDate: "2026-02-10",
    location: "Building A, Floor 3",
    threatLevel: "clear",
    threatsFound: 0,
    protocols: ["WiFi", "Bluetooth", "RF"],
    poweredBy: "routes/tscm.py (tscm_sweeps, tscm_cases)",
    analyst: "Operator 1",
    duration: "2h 15m",
    roomSize: "45 m²",
    baselineDeviation: 3.2,
    sweepData: generateSweepData(),
    threats: [],
    protocolCoverage: [
      { protocol: "WiFi 2.4GHz", scanned: true, anomalies: 0, devices: 4 },
      { protocol: "WiFi 5GHz", scanned: true, anomalies: 0, devices: 2 },
      { protocol: "Bluetooth LE", scanned: true, anomalies: 0, devices: 3 },
      { protocol: "Bluetooth Classic", scanned: true, anomalies: 0, devices: 1 },
      { protocol: "RF 433MHz", scanned: true, anomalies: 0, devices: 0 },
      { protocol: "RF 868MHz", scanned: true, anomalies: 0, devices: 0 },
      { protocol: "GSM 900", scanned: false, anomalies: 0, devices: 0 },
      { protocol: "GSM 1800", scanned: false, anomalies: 0, devices: 0 },
    ],
    notes: "Routine weekly sweep. All detected devices matched baseline inventory. No anomalous emissions detected.",
  },
  {
    id: "tscm2",
    caseName: "Executive Suite",
    sweepDate: "2026-02-08",
    location: "Building B, Floor 7",
    threatLevel: "suspicious",
    threatsFound: 2,
    protocols: ["WiFi", "Bluetooth", "RF", "GSM"],
    poweredBy: "routes/tscm.py (tscm_sweeps, tscm_cases)",
    analyst: "Operator 2",
    duration: "3h 45m",
    roomSize: "78 m²",
    baselineDeviation: 34.7,
    sweepData: (() => {
      const d = generateSweepData();
      d[14].anomalyScore = 0.82;
      d[15].anomalyScore = 0.91;
      d[14].rf = 5;
      d[15].rf = 7;
      return d;
    })(),
    threats: [
      { id: "t1", type: "Unknown Transmitter", protocol: "RF 433MHz", frequency: "433.42 MHz", signalStrength: -38, description: "Intermittent narrow-band emission detected at 433.42 MHz. Signal pattern inconsistent with known IoT devices. Duty cycle suggests periodic burst transmission (every ~90s).", severity: "high", status: "monitoring" },
      { id: "t2", type: "Rogue AP", protocol: "WiFi 2.4GHz", frequency: "2.437 GHz (Ch 6)", signalStrength: -52, description: "Unregistered access point 'DIRECT-xx' detected. MAC OUI resolves to generic chipset. Not present in baseline inventory. Possible evil twin or unauthorized hotspot.", severity: "medium", status: "active" },
    ],
    protocolCoverage: [
      { protocol: "WiFi 2.4GHz", scanned: true, anomalies: 1, devices: 8 },
      { protocol: "WiFi 5GHz", scanned: true, anomalies: 0, devices: 5 },
      { protocol: "Bluetooth LE", scanned: true, anomalies: 0, devices: 6 },
      { protocol: "Bluetooth Classic", scanned: true, anomalies: 0, devices: 2 },
      { protocol: "RF 433MHz", scanned: true, anomalies: 1, devices: 1 },
      { protocol: "RF 868MHz", scanned: true, anomalies: 0, devices: 0 },
      { protocol: "GSM 900", scanned: true, anomalies: 0, devices: 3 },
      { protocol: "GSM 1800", scanned: true, anomalies: 0, devices: 2 },
    ],
    notes: "Elevated sweep triggered by security team. Two anomalies identified. RF 433MHz transmitter requires physical inspection. Rogue AP flagged for IT security review. Recommend follow-up sweep within 48h.",
  },
  {
    id: "tscm3",
    caseName: "Boardroom Weekly",
    sweepDate: "2026-02-05",
    location: "Building A, Floor 5",
    threatLevel: "clear",
    threatsFound: 0,
    protocols: ["WiFi", "Bluetooth"],
    poweredBy: "routes/tscm.py (tscm_sweeps, tscm_cases)",
    analyst: "Operator 1",
    duration: "1h 30m",
    roomSize: "32 m²",
    baselineDeviation: 1.8,
    sweepData: generateSweepData(),
    threats: [],
    protocolCoverage: [
      { protocol: "WiFi 2.4GHz", scanned: true, anomalies: 0, devices: 3 },
      { protocol: "WiFi 5GHz", scanned: true, anomalies: 0, devices: 1 },
      { protocol: "Bluetooth LE", scanned: true, anomalies: 0, devices: 2 },
      { protocol: "Bluetooth Classic", scanned: true, anomalies: 0, devices: 0 },
      { protocol: "RF 433MHz", scanned: false, anomalies: 0, devices: 0 },
      { protocol: "RF 868MHz", scanned: false, anomalies: 0, devices: 0 },
    ],
    notes: "Standard weekly sweep. Environment consistent with baseline. No concerns.",
  },
  {
    id: "tscm4",
    caseName: "Server Room Audit",
    sweepDate: "2026-02-01",
    location: "Building C, Basement",
    threatLevel: "compromised",
    threatsFound: 4,
    protocols: ["WiFi", "Bluetooth", "RF", "GSM"],
    poweredBy: "routes/tscm.py (tscm_sweeps, tscm_cases)",
    analyst: "Operator 3",
    duration: "5h 20m",
    roomSize: "120 m²",
    baselineDeviation: 72.4,
    sweepData: (() => {
      const d = generateSweepData();
      d[10].anomalyScore = 0.95;
      d[11].anomalyScore = 0.88;
      d[12].anomalyScore = 0.92;
      d[13].anomalyScore = 0.78;
      d[10].rf = 8;
      d[11].gsm = 5;
      return d;
    })(),
    threats: [
      { id: "t3", type: "Covert Transmitter", protocol: "RF 868MHz", frequency: "868.35 MHz", signalStrength: -28, description: "Strong narrow-band emission at 868.35 MHz detected near server rack B-7. Signal modulation consistent with FSK data link. Not correlated to any known facility equipment.", severity: "critical", status: "active" },
      { id: "t4", type: "GSM IMSI Catcher", protocol: "GSM 900", frequency: "935.2 MHz", signalStrength: -45, description: "Anomalous GSM base station detected. Cell ID does not match any registered operator tower. Signal strength suggests proximity device. Possible IMSI catcher / stingray.", severity: "critical", status: "active" },
      { id: "t5", type: "Rogue AP", protocol: "WiFi 5GHz", frequency: "5.240 GHz (Ch 48)", signalStrength: -40, description: "Hidden SSID access point on channel 48. High signal strength suggests device is within the room. MAC address not in facility inventory.", severity: "high", status: "active" },
      { id: "t6", type: "BLE Beacon", protocol: "Bluetooth LE", frequency: "2.402 GHz", signalStrength: -55, description: "Unknown BLE beacon broadcasting iBeacon frames. UUID does not match any registered facility beacons. Advertising interval: 100ms (unusually fast).", severity: "medium", status: "monitoring" },
    ],
    protocolCoverage: [
      { protocol: "WiFi 2.4GHz", scanned: true, anomalies: 0, devices: 12 },
      { protocol: "WiFi 5GHz", scanned: true, anomalies: 1, devices: 8 },
      { protocol: "Bluetooth LE", scanned: true, anomalies: 1, devices: 9 },
      { protocol: "Bluetooth Classic", scanned: true, anomalies: 0, devices: 3 },
      { protocol: "RF 433MHz", scanned: true, anomalies: 0, devices: 2 },
      { protocol: "RF 868MHz", scanned: true, anomalies: 1, devices: 1 },
      { protocol: "GSM 900", scanned: true, anomalies: 1, devices: 4 },
      { protocol: "GSM 1800", scanned: true, anomalies: 0, devices: 2 },
    ],
    notes: "CRITICAL — Full compromise detected. Four independent threats identified across multiple protocol bands. Immediate physical inspection of server rack B-7 required. GSM anomaly suggests active surveillance device. Facility lockdown recommended pending investigation.",
  },
];

const threatLevelConfig = {
  clear: { bg: "bg-chart-4/10", text: "text-chart-4", label: "CLEAR", icon: CheckCircle2, ringColor: "oklch(0.7 0.15 145)" },
  suspicious: { bg: "bg-chart-5/10", text: "text-chart-5", label: "SUSPICIOUS", icon: AlertTriangle, ringColor: "oklch(0.75 0.18 60)" },
  compromised: { bg: "bg-destructive/10", text: "text-destructive", label: "COMPROMISED", icon: XCircle, ringColor: "oklch(0.6 0.22 25)" },
};

const severityConfig = {
  low: { bg: "bg-chart-2/10", text: "text-chart-2", label: "LOW" },
  medium: { bg: "bg-chart-5/10", text: "text-chart-5", label: "MED" },
  high: { bg: "bg-primary/10", text: "text-primary", label: "HIGH" },
  critical: { bg: "bg-destructive/10", text: "text-destructive", label: "CRIT" },
};

const threatStatusConfig = {
  active: { bg: "bg-destructive/10", text: "text-destructive", label: "ACTIVE" },
  resolved: { bg: "bg-chart-4/10", text: "text-chart-4", label: "RESOLVED" },
  monitoring: { bg: "bg-chart-5/10", text: "text-chart-5", label: "MONITORING" },
};

const statusColors = {
  complete: { bg: "bg-chart-4/10", text: "text-chart-4" },
  partial: { bg: "bg-chart-5/10", text: "text-chart-5" },
  error: { bg: "bg-destructive/10", text: "text-destructive" },
};

// ─── Threat Level Gauge ────────────────────────────────────────────────────

function ThreatGauge({ level, deviation }: { level: ThreatLevel; deviation: number }) {
  const cfg = threatLevelConfig[level];
  const IconComp = cfg.icon;
  const pct = level === "clear" ? 0.1 : level === "suspicious" ? 0.55 : 0.9;
  const circumference = 2 * Math.PI * 54;
  const dashOffset = circumference * (1 - pct * 0.75);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-32 h-32">
        <svg viewBox="0 0 120 120" className="w-full h-full -rotate-[135deg]">
          {/* Background arc */}
          <circle
            cx="60" cy="60" r="54"
            fill="none"
            stroke="oklch(0.2 0.02 285)"
            strokeWidth="6"
            strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
            strokeLinecap="round"
          />
          {/* Value arc */}
          <circle
            cx="60" cy="60" r="54"
            fill="none"
            stroke={cfg.ringColor}
            strokeWidth="6"
            strokeDasharray={`${circumference * 0.75} ${circumference * 0.25}`}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            className="transition-all duration-1000 ease-out"
            style={{ filter: `drop-shadow(0 0 6px ${cfg.ringColor})` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <IconComp className={cn("w-6 h-6 mb-1", cfg.text)} />
          <span className={cn("text-[10px] font-mono font-bold tracking-wider", cfg.text)}>
            {cfg.label}
          </span>
        </div>
      </div>
      <div className="text-center">
        <span className="text-xs font-mono text-muted-foreground">Baseline Δ</span>
        <span className={cn("text-sm font-mono font-bold ml-1.5", deviation > 30 ? "text-destructive" : deviation > 10 ? "text-chart-5" : "text-chart-4")}>
          {deviation.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

// ─── Sweep Timeline Chart (Canvas) ─────────────────────────────────────────

function SweepTimelineChart({ data }: { data: TSCMSweepPoint[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 2;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const padding = { top: 20, right: 16, bottom: 32, left: 36 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Find max device count for scaling
    const maxDevices = Math.max(...data.map(d => d.wifi + d.bluetooth + d.rf + d.gsm), 1);
    const maxAnomaly = 1;

    // Draw grid lines
    ctx.strokeStyle = "oklch(0.65 0.18 285 / 0.08)";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
    }

    // X-axis labels
    ctx.fillStyle = "oklch(0.55 0.02 285)";
    ctx.font = "9px 'IBM Plex Mono', monospace";
    ctx.textAlign = "center";
    data.forEach((point, i) => {
      if (i % 4 === 0) {
        const x = padding.left + (chartW / (data.length - 1)) * i;
        ctx.fillText(point.time, x, h - 8);
      }
    });

    // Y-axis labels
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartH / 4) * i;
      const val = Math.round(maxDevices * (1 - i / 4));
      ctx.fillText(String(val), padding.left - 6, y + 3);
    }

    // Draw stacked area — WiFi
    const drawArea = (getValue: (d: TSCMSweepPoint) => number, color: string, alpha: number) => {
      ctx.beginPath();
      data.forEach((point, i) => {
        const x = padding.left + (chartW / (data.length - 1)) * i;
        const y = padding.top + chartH * (1 - getValue(point) / maxDevices);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      // Close to bottom
      ctx.lineTo(padding.left + chartW, padding.top + chartH);
      ctx.lineTo(padding.left, padding.top + chartH);
      ctx.closePath();
      ctx.fillStyle = color.replace("1)", `${alpha})`);
      ctx.fill();

      // Line on top
      ctx.beginPath();
      data.forEach((point, i) => {
        const x = padding.left + (chartW / (data.length - 1)) * i;
        const y = padding.top + chartH * (1 - getValue(point) / maxDevices);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };

    // Stacked: GSM → RF → BT → WiFi (bottom to top)
    drawArea(d => d.wifi + d.bluetooth + d.rf + d.gsm, "oklch(0.7 0.18 285 / 1)", 0.08);
    drawArea(d => d.wifi + d.bluetooth + d.rf, "oklch(0.78 0.15 195 / 1)", 0.1);
    drawArea(d => d.wifi + d.bluetooth, "oklch(0.65 0.2 330 / 1)", 0.12);
    drawArea(d => d.wifi, "oklch(0.7 0.15 145 / 1)", 0.15);

    // Anomaly overlay — red dots
    data.forEach((point, i) => {
      if (point.anomalyScore > 0.5) {
        const x = padding.left + (chartW / (data.length - 1)) * i;
        const y = padding.top + 10;
        const r = 3 + point.anomalyScore * 4;

        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `oklch(0.6 0.22 25 / ${0.3 + point.anomalyScore * 0.5})`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fillStyle = "oklch(0.6 0.22 25)";
        ctx.fill();
      }
    });

  }, [data]);

  return (
    <div className="w-full h-full">
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
}

// ─── Protocol Coverage Grid ────────────────────────────────────────────────

function ProtocolCoverageGrid({ coverage }: { coverage: TSCMReport["protocolCoverage"] }) {
  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
      {coverage.map((proto) => (
        <div
          key={proto.protocol}
          className={cn(
            "px-3 py-2.5 rounded-md border transition-all",
            proto.scanned
              ? proto.anomalies > 0
                ? "border-destructive/30 bg-destructive/5"
                : "border-chart-4/20 bg-chart-4/5"
              : "border-border/20 bg-muted/10 opacity-50"
          )}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-mono font-medium text-foreground truncate">
              {proto.protocol}
            </span>
            {proto.scanned ? (
              proto.anomalies > 0 ? (
                <AlertTriangle className="w-3 h-3 text-destructive shrink-0" />
              ) : (
                <CheckCircle2 className="w-3 h-3 text-chart-4 shrink-0" />
              )
            ) : (
              <span className="text-[8px] font-mono text-muted-foreground">SKIP</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-[9px] font-mono text-muted-foreground">
            <span>{proto.devices} dev</span>
            {proto.anomalies > 0 && (
              <span className="text-destructive font-medium">{proto.anomalies} anomaly</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Threat Detail Card ────────────────────────────────────────────────────

function ThreatCard({ threat }: { threat: TSCMThreat }) {
  const [expanded, setExpanded] = useState(false);
  const sevCfg = severityConfig[threat.severity];
  const stCfg = threatStatusConfig[threat.status];

  return (
    <div className={cn(
      "rounded-md border transition-all",
      threat.severity === "critical"
        ? "border-destructive/30 bg-destructive/5"
        : threat.severity === "high"
        ? "border-primary/20 bg-primary/5"
        : "border-border/20 bg-muted/10"
    )}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
      >
        <AlertTriangle className={cn("w-3.5 h-3.5 shrink-0", sevCfg.text)} />
        <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-mono font-medium shrink-0", sevCfg.bg, sevCfg.text)}>
          {sevCfg.label}
        </span>
        <span className="text-xs font-medium text-foreground flex-1 truncate">
          {threat.type}
        </span>
        <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-mono font-medium shrink-0", stCfg.bg, stCfg.text)}>
          {stCfg.label}
        </span>
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
          <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
            <div>
              <span className="text-muted-foreground">Protocol</span>
              <div className="text-foreground mt-0.5">{threat.protocol}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Frequency</span>
              <div className="text-foreground mt-0.5">{threat.frequency}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Signal</span>
              <div className={cn("mt-0.5 font-medium", threat.signalStrength > -40 ? "text-destructive" : "text-chart-5")}>
                {threat.signalStrength} dBm
              </div>
            </div>
          </div>
          <div className="text-[11px] font-mono text-muted-foreground leading-relaxed p-2.5 rounded bg-muted/20 border border-border/10">
            {threat.description}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TSCM Report Detail Drawer ─────────────────────────────────────────────

function TSCMDetailDrawer({ report, onClose }: { report: TSCMReport; onClose: () => void }) {
  const cfg = threatLevelConfig[report.threatLevel];

  return (
    <div className="w-[480px] 2xl:w-[560px] shrink-0 glass-panel rounded-lg overflow-hidden flex flex-col animate-in slide-in-from-right-4 duration-300">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Shield className="w-4 h-4 text-primary" />
          <div>
            <h3 className="text-sm font-display font-semibold text-foreground">{report.caseName}</h3>
            <p className="text-[10px] font-mono text-muted-foreground">{report.location} · {report.sweepDate}</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-accent/30 transition-colors">
          <X className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Threat gauge + stats row */}
        <div className="flex items-start gap-6">
          <ThreatGauge level={report.threatLevel} deviation={report.baselineDeviation} />
          <div className="flex-1 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="px-3 py-2 rounded-md bg-muted/20 border border-border/10">
                <span className="text-[9px] font-mono text-muted-foreground uppercase">Duration</span>
                <div className="text-sm font-mono text-foreground mt-0.5">{report.duration}</div>
              </div>
              <div className="px-3 py-2 rounded-md bg-muted/20 border border-border/10">
                <span className="text-[9px] font-mono text-muted-foreground uppercase">Room Size</span>
                <div className="text-sm font-mono text-foreground mt-0.5">{report.roomSize}</div>
              </div>
              <div className="px-3 py-2 rounded-md bg-muted/20 border border-border/10">
                <span className="text-[9px] font-mono text-muted-foreground uppercase">Analyst</span>
                <div className="text-sm font-mono text-foreground mt-0.5">{report.analyst}</div>
              </div>
              <div className="px-3 py-2 rounded-md bg-muted/20 border border-border/10">
                <span className="text-[9px] font-mono text-muted-foreground uppercase">Threats</span>
                <div className={cn("text-sm font-mono font-bold mt-0.5", report.threatsFound > 0 ? "text-destructive" : "text-chart-4")}>
                  {report.threatsFound}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sweep Timeline */}
        <div>
          <h4 className="text-xs font-display font-semibold text-foreground mb-2 flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-primary" />
            Sweep Timeline
          </h4>
          <div className="glass-card rounded-md p-2 h-44">
            <SweepTimelineChart data={report.sweepData} />
          </div>
          <div className="flex items-center gap-4 mt-2 text-[9px] font-mono text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-chart-4" />WiFi</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-chart-3" />Bluetooth</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-chart-2" />RF</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-primary" />GSM</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-destructive" />Anomaly</span>
          </div>
        </div>

        {/* Protocol Coverage */}
        <div>
          <h4 className="text-xs font-display font-semibold text-foreground mb-2 flex items-center gap-2">
            <Signal className="w-3.5 h-3.5 text-primary" />
            Protocol Coverage
          </h4>
          <ProtocolCoverageGrid coverage={report.protocolCoverage} />
        </div>

        {/* Threats */}
        {report.threats.length > 0 && (
          <div>
            <h4 className="text-xs font-display font-semibold text-foreground mb-2 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
              Detected Threats ({report.threats.length})
            </h4>
            <div className="space-y-2">
              {report.threats.map((threat) => (
                <ThreatCard key={threat.id} threat={threat} />
              ))}
            </div>
          </div>
        )}

        {/* Analyst Notes */}
        <div>
          <h4 className="text-xs font-display font-semibold text-foreground mb-2 flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-primary" />
            Analyst Notes
          </h4>
          <div className="text-xs font-mono text-muted-foreground leading-relaxed p-3 rounded-md bg-muted/20 border border-border/10">
            {report.notes}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-border/20 flex items-center justify-between">
        <span className="text-[10px] font-mono text-muted-foreground/60">
          Powered by: {report.poweredBy}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-[10px] font-mono h-7"
          onClick={() => toast("Exporting TSCM report PDF...", { description: "Powered by: GET /tscm/report/export" })}
        >
          <Download className="w-3 h-3" />
          Export PDF
        </Button>
      </div>
    </div>
  );
}

// ─── TSCM Summary Cards ───────────────────────────────────────────────────

function TSCMSummaryBar({ reports }: { reports: TSCMReport[] }) {
  const clearCount = reports.filter(r => r.threatLevel === "clear").length;
  const suspiciousCount = reports.filter(r => r.threatLevel === "suspicious").length;
  const compromisedCount = reports.filter(r => r.threatLevel === "compromised").length;
  const totalThreats = reports.reduce((sum, r) => sum + r.threatsFound, 0);

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div className="glass-card rounded-md px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Shield className="w-3.5 h-3.5 text-primary" />
          <span className="text-[10px] font-mono text-muted-foreground uppercase">Total Sweeps</span>
        </div>
        <span className="text-xl font-display font-bold text-foreground">{reports.length}</span>
      </div>
      <div className="glass-card rounded-md px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <CheckCircle2 className="w-3.5 h-3.5 text-chart-4" />
          <span className="text-[10px] font-mono text-muted-foreground uppercase">Clear</span>
        </div>
        <span className="text-xl font-display font-bold text-chart-4">{clearCount}</span>
      </div>
      <div className="glass-card rounded-md px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle className="w-3.5 h-3.5 text-chart-5" />
          <span className="text-[10px] font-mono text-muted-foreground uppercase">Suspicious</span>
        </div>
        <span className="text-xl font-display font-bold text-chart-5">{suspiciousCount}</span>
      </div>
      <div className="glass-card rounded-md px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Zap className="w-3.5 h-3.5 text-destructive" />
          <span className="text-[10px] font-mono text-muted-foreground uppercase">Active Threats</span>
        </div>
        <span className="text-xl font-display font-bold text-destructive">{totalThreats}</span>
      </div>
    </div>
  );
}

// ─── Main Export ───────────────────────────────────────────────────────────

export default function HistoryPage() {
  const [tab, setTab] = useState<"recordings" | "tscm">("recordings");
  const [selectedReport, setSelectedReport] = useState<TSCMReport | null>(null);

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-5rem)]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-display font-bold tracking-wide">History</h1>
          <p className="text-sm font-mono text-muted-foreground mt-1">
            {mockSessions.length} recordings · {mockTSCM.length} TSCM reports
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-2 text-xs font-mono"
            onClick={() => toast("Export all recordings", { description: "Powered by: GET /recordings/export" })}
          >
            <Download className="w-3 h-3" />
            Export All
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 glass-panel rounded-lg p-1 w-fit">
        <button
          onClick={() => { setTab("recordings"); setSelectedReport(null); }}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-mono transition-all",
            tab === "recordings" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          <HardDrive className="w-3.5 h-3.5" />
          Recordings
          <span className="text-[10px] text-muted-foreground">{mockSessions.length}</span>
        </button>
        <button
          onClick={() => setTab("tscm")}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-mono transition-all",
            tab === "tscm" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Shield className="w-3.5 h-3.5" />
          TSCM Reports
          <span className="text-[10px] text-muted-foreground">{mockTSCM.length}</span>
        </button>
      </div>

      {/* Content */}
      {tab === "recordings" ? (
        <div className="flex-1 min-h-0 space-y-3 overflow-y-auto">
          {["2026-02-10", "2026-02-09"].map((date) => {
            const sessions = mockSessions.filter((s) => s.date === date);
            if (sessions.length === 0) return null;
            return (
              <div key={date}>
                <div className="flex items-center gap-2 mb-2">
                  <Calendar className="w-3 h-3 text-muted-foreground" />
                  <span className="text-xs font-mono text-muted-foreground">{date}</span>
                  <div className="flex-1 glass-divider" />
                </div>
                <div className="space-y-2">
                  {sessions.map((session) => {
                    const stCfg = statusColors[session.status];
                    return (
                      <GlassPanel key={session.id} className="glass-card" noPadding>
                        <div className="flex items-center gap-4 px-4 py-3">
                          <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                            <session.icon className="w-[18px] h-[18px] text-primary" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-foreground">{session.type}</span>
                              <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-mono font-medium", stCfg.bg, stCfg.text)}>
                                {session.status.toUpperCase()}
                              </span>
                            </div>
                            <div className="flex items-center gap-3 mt-1 text-[11px] font-mono text-muted-foreground">
                              <span>{session.startTime} — {session.endTime}</span>
                              <span>·</span>
                              <span>{session.duration}</span>
                              <span>·</span>
                              <span>{session.deviceCount} devices</span>
                              <span>·</span>
                              <span>{session.signalCount.toLocaleString()} signals</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-xs font-mono text-muted-foreground">{session.fileSize}</span>
                            <Button variant="ghost" size="icon" className="h-7 w-7"
                              onClick={() => toast("Replaying session...", { description: `Powered by: ${session.poweredBy}` })}>
                              <Play className="w-3.5 h-3.5 text-primary" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7"
                              onClick={() => toast("Downloading...", { description: `Powered by: GET /recordings/${session.id}/download` })}>
                              <Download className="w-3.5 h-3.5 text-muted-foreground" />
                            </Button>
                          </div>
                        </div>
                        <div className="px-4 py-1.5 border-t border-border/15">
                          <span className="text-[10px] font-mono text-muted-foreground/50">
                            Powered by: {session.poweredBy}
                          </span>
                        </div>
                      </GlassPanel>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col gap-4">
          {/* Summary bar */}
          <TSCMSummaryBar reports={mockTSCM} />

          {/* Report list + detail drawer */}
          <div className="flex gap-4 flex-1 min-h-0">
            {/* Report list */}
            <div className="flex-1 min-w-0 space-y-2 overflow-y-auto">
              {mockTSCM.map((report) => {
                const tCfg = threatLevelConfig[report.threatLevel];
                const ThreatIcon = tCfg.icon;
                const isSelected = selectedReport?.id === report.id;
                return (
                  <GlassPanel
                    key={report.id}
                    className={cn(
                      "glass-card cursor-pointer",
                      isSelected && "!border-primary/30 !bg-primary/5"
                    )}
                    noPadding
                  >
                    <button
                      onClick={() => setSelectedReport(isSelected ? null : report)}
                      className="w-full text-left"
                    >
                      <div className="flex items-center gap-4 px-4 py-3">
                        <div className={cn(
                          "w-9 h-9 rounded-md flex items-center justify-center shrink-0",
                          report.threatLevel === "compromised" ? "bg-destructive/10" :
                          report.threatLevel === "suspicious" ? "bg-chart-5/10" : "bg-chart-4/10"
                        )}>
                          <ThreatIcon className={cn("w-[18px] h-[18px]", tCfg.text)} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">{report.caseName}</span>
                            <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-mono font-medium", tCfg.bg, tCfg.text)}>
                              {tCfg.label}
                            </span>
                            {report.threatsFound > 0 && (
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-mono font-medium bg-destructive/10 text-destructive">
                                {report.threatsFound} THREAT{report.threatsFound > 1 ? "S" : ""}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-[11px] font-mono text-muted-foreground">
                            <span>{report.sweepDate}</span>
                            <span>·</span>
                            <span>{report.location}</span>
                            <span>·</span>
                            <span>{report.duration}</span>
                            <span>·</span>
                            <span>{report.protocols.join(", ")}</span>
                          </div>
                        </div>
                        <ChevronRight className={cn(
                          "w-4 h-4 shrink-0 transition-transform",
                          isSelected ? "text-primary rotate-0" : "text-muted-foreground/40"
                        )} />
                      </div>
                      <div className="px-4 py-1.5 border-t border-border/15">
                        <span className="text-[10px] font-mono text-muted-foreground/50">
                          Powered by: {report.poweredBy}
                        </span>
                      </div>
                    </button>
                  </GlassPanel>
                );
              })}
            </div>

            {/* Detail drawer */}
            {selectedReport && (
              <TSCMDetailDrawer
                report={selectedReport}
                onClose={() => setSelectedReport(null)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
