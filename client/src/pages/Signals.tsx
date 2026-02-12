/**
 * Signals Page — Log of discrete signal events and decoded messages
 * Design: Obsidian Prism — timeline-based event feed with filtering
 * 
 * Powered by:
 *   Pager messages → pager_queue (routes/pager.py)
 *   ACARS messages → acars_queue (routes/acars.py)
 *   DSC alerts → DataStore dsc_messages (routes/dsc.py)
 *   APRS packets → aprs_queue (routes/aprs.py)
 *   Sensor readings → sensor_queue (routes/sensor.py)
 *   Meshtastic → meshtastic messages (routes/meshtastic.py)
 *   WiFi handshakes → wifi_handshakes (routes/wifi_v2.py)
 *   Alert events → alert_events table (utils/database.py)
 */
import { useState } from "react";
import {
  MessageSquare,
  Plane,
  Waves,
  Navigation,
  Gauge,
  AlertTriangle,
  Wifi,
  Binary,
  Filter,
  Search,
  ChevronDown,
  ChevronRight,
  Clock,
  Radio,
} from "lucide-react";
import { cn } from "@/lib/utils";
import GlassPanel from "@/components/GlassPanel";

type SignalType = "pager" | "acars" | "dsc" | "aprs" | "sensor" | "alert" | "handshake" | "meshtastic";

interface SignalEvent {
  id: string;
  type: SignalType;
  timestamp: string;
  source: string;
  summary: string;
  detail: string;
  severity: "info" | "warning" | "critical";
  poweredBy: string;
}

const mockSignals: SignalEvent[] = [
  { id: "s1", type: "pager", timestamp: "14:32:15", source: "POCSAG 1200", summary: "Cap Code: 0003456 — Numeric page received", detail: "Message: 07891234567 — Function: 0 — Baud: 1200", severity: "info", poweredBy: "routes/pager.py (pager_queue)" },
  { id: "s2", type: "acars", timestamp: "14:31:58", source: "131.550 MHz", summary: "BAW156 → ACARS position report", detail: "Label: H1 — Block: 6 — Ack: ! — Msg: /EGLL.TI2/056KBOS", severity: "info", poweredBy: "routes/acars.py (acars_queue)" },
  { id: "s3", type: "dsc", timestamp: "14:31:42", source: "2187.5 kHz", summary: "DSC Distress Alert — MMSI: 211234567", detail: "Nature: Flooding — Position: 51°28'N 000°27'W — Time: 1431 UTC", severity: "critical", poweredBy: "routes/dsc.py (dsc_messages DataStore)" },
  { id: "s4", type: "aprs", timestamp: "14:31:20", source: "144.390 MHz", summary: "G4ABC-9 Position Report", detail: "Lat: 51.4772 Lon: -0.0005 — Comment: /A=000150 — Path: WIDE1-1,WIDE2-1", severity: "info", poweredBy: "routes/aprs.py (aprs_queue)" },
  { id: "s5", type: "sensor", timestamp: "14:31:05", source: "433.92 MHz", summary: "Acurite-5n1 Weather Station — Temp: 12.3°C", detail: "Humidity: 67% — Wind: 8.2 km/h NW — Rain: 0.0mm — Battery: OK", severity: "info", poweredBy: "routes/sensor.py (sensor_queue)" },
  { id: "s6", type: "alert", timestamp: "14:30:48", source: "Alert Engine", summary: "WiFi Deauth Attack Detected", detail: "Target: AA:BB:CC:DD:EE:01 (NETGEAR-5G) — Source: DE:AD:BE:EF:00:01 — Count: 47 frames", severity: "critical", poweredBy: "routes/alerts.py (alert_events table)" },
  { id: "s7", type: "handshake", timestamp: "14:30:30", source: "Channel 36", summary: "WPA Handshake Captured — NETGEAR-5G", detail: "BSSID: AA:BB:CC:DD:EE:01 — Client: FF:EE:DD:CC:BB:AA — EAPOL frames: 4/4", severity: "warning", poweredBy: "routes/wifi_v2.py (wifi_handshakes)" },
  { id: "s8", type: "pager", timestamp: "14:30:15", source: "POCSAG 512", summary: "Cap Code: 0007890 — Alpha page received", detail: "Message: AMBULANCE REQ — UNIT 42 — LOC: HIGH STREET — PRI: 1", severity: "warning", poweredBy: "routes/pager.py (pager_queue)" },
  { id: "s9", type: "meshtastic", timestamp: "14:29:55", source: "LoRa 915MHz", summary: "Meshtastic Text — Node: !a1b2c3d4", detail: "Message: 'Base camp check-in' — SNR: 9.5 — Hops: 2", severity: "info", poweredBy: "routes/meshtastic.py" },
  { id: "s10", type: "sensor", timestamp: "14:29:30", source: "433.92 MHz", summary: "LaCrosse TX141 — Temp: 8.7°C", detail: "Channel: 1 — Battery: Low — Model: TX141TH-Bv2", severity: "info", poweredBy: "routes/sensor.py (sensor_queue)" },
];

const typeConfig: Record<SignalType, { icon: typeof Radio; label: string; color: string }> = {
  pager: { icon: MessageSquare, label: "Pager", color: "text-chart-5" },
  acars: { icon: Plane, label: "ACARS", color: "text-chart-2" },
  dsc: { icon: Waves, label: "DSC", color: "text-destructive" },
  aprs: { icon: Navigation, label: "APRS", color: "text-chart-4" },
  sensor: { icon: Gauge, label: "Sensor", color: "text-primary" },
  alert: { icon: AlertTriangle, label: "Alert", color: "text-destructive" },
  handshake: { icon: Wifi, label: "Handshake", color: "text-chart-5" },
  meshtastic: { icon: Binary, label: "Meshtastic", color: "text-chart-3" },
};

const severityConfig = {
  info: { bg: "bg-chart-2/10", text: "text-chart-2", label: "INFO" },
  warning: { bg: "bg-chart-5/10", text: "text-chart-5", label: "WARN" },
  critical: { bg: "bg-destructive/10", text: "text-destructive", label: "CRIT" },
};

function SignalEventRow({ event, expanded, onToggle }: { event: SignalEvent; expanded: boolean; onToggle: () => void }) {
  const typeCfg = typeConfig[event.type];
  const sevCfg = severityConfig[event.severity];

  return (
    <div
      className={cn(
        "border-b border-border/10 transition-colors",
        expanded ? "bg-accent/15" : "hover:bg-accent/10"
      )}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        <span className="text-xs font-mono text-muted-foreground w-16 shrink-0">
          {event.timestamp}
        </span>
        <typeCfg.icon className={cn("w-3.5 h-3.5 shrink-0", typeCfg.color)} />
        <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-mono font-medium shrink-0", sevCfg.bg, sevCfg.text)}>
          {sevCfg.label}
        </span>
        <span className="text-xs font-mono text-muted-foreground shrink-0 w-24 truncate">
          {event.source}
        </span>
        <span className="text-sm text-foreground flex-1 truncate">
          {event.summary}
        </span>
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-3 pl-[7.5rem] space-y-2 animate-in fade-in duration-200">
          <div className="text-xs font-mono text-muted-foreground leading-relaxed p-3 rounded bg-muted/20">
            {event.detail}
          </div>
          <span className="text-[10px] font-mono text-muted-foreground/50">
            Powered by: {event.poweredBy}
          </span>
        </div>
      )}
    </div>
  );
}

export default function SignalsPage() {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<SignalType | "all">("all");
  const [search, setSearch] = useState("");

  const filtered = mockSignals.filter((s) => {
    if (typeFilter !== "all" && s.type !== typeFilter) return false;
    if (search && !s.summary.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-5rem)]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-display font-bold tracking-wide">Signals</h1>
          <p className="text-sm font-mono text-muted-foreground mt-1">
            {mockSignals.length} events captured · {mockSignals.filter(s => s.severity === "critical").length} critical
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-chart-2 pulse-live" />
          <span className="text-xs font-mono text-chart-2">LIVE FEED</span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 glass-panel rounded-lg p-1">
          <button
            onClick={() => setTypeFilter("all")}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-mono transition-all",
              typeFilter === "all" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            All
          </button>
          {(Object.keys(typeConfig) as SignalType[]).map((type) => {
            const cfg = typeConfig[type];
            return (
              <button
                key={type}
                onClick={() => setTypeFilter(type)}
                className={cn(
                  "flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-mono transition-all",
                  typeFilter === type ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <cfg.icon className={cn("w-3 h-3", typeFilter === type ? cfg.color : "")} />
                {cfg.label}
              </button>
            );
          })}
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Filter signals..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-9 pr-3 rounded-md bg-muted/30 border border-border/50 text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors w-64"
          />
        </div>
      </div>

      {/* Signal feed */}
      <GlassPanel className="flex-1 min-h-0 flex flex-col" noPadding>
        {/* Column headers */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-border/30 text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
          <span className="w-16 shrink-0">TIME</span>
          <span className="w-3.5 shrink-0"></span>
          <span className="w-10 shrink-0">SEV</span>
          <span className="w-24 shrink-0">SOURCE</span>
          <span className="flex-1">EVENT</span>
        </div>

        {/* Event list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.map((event) => (
            <SignalEventRow
              key={event.id}
              event={event}
              expanded={expandedId === event.id}
              onToggle={() => setExpandedId(expandedId === event.id ? null : event.id)}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border/20 flex items-center justify-between">
          <span className="text-[10px] font-mono text-muted-foreground/60">
            Powered by: SSE streams from all active decoders
          </span>
          <span className="text-[10px] font-mono text-muted-foreground/60">
            {filtered.length} of {mockSignals.length} events shown
          </span>
        </div>
      </GlassPanel>
    </div>
  );
}
