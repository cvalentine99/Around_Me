/**
 * Devices Page — Comprehensive inventory of all detected devices
 * Design: Obsidian Prism — filterable table with detail drawers
 * 
 * Powered by:
 *   WiFi networks → DataStore wifi_networks (routes/wifi_v2.py)
 *   WiFi clients → DataStore wifi_clients (routes/wifi_v2.py)
 *   Bluetooth → DataStore bt_devices (routes/bluetooth_v2.py)
 *   Aircraft → DataStore adsb_aircraft (routes/adsb.py)
 *   Vessels → DataStore ais_vessels (routes/ais.py)
 *   Correlations → device_correlations table (utils/database.py)
 *   IoT Sensors → DataStore via routes/sensor.py
 */
import { useState, useCallback } from "react";
import {
  Wifi,
  Bluetooth,
  Plane,
  Ship,
  Radio,
  Cpu,
  Search,
  Filter,
  Download,
  ChevronRight,
  X,
  Link2,
  Signal,
  Clock,
  Shield,
  Gauge,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import GlassPanel from "@/components/GlassPanel";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type DeviceType = "wifi" | "bluetooth" | "aircraft" | "vessel" | "sensor" | "all";

interface Device {
  id: string;
  name: string;
  type: DeviceType;
  identifier: string;
  signal: number;
  firstSeen: string;
  lastSeen: string;
  metadata: Record<string, string>;
  correlated?: string;
}

const mockDevices: Device[] = [
  { id: "1", name: "NETGEAR-5G", type: "wifi", identifier: "AA:BB:CC:DD:EE:01", signal: -42, firstSeen: "14:22:01", lastSeen: "2s ago", metadata: { channel: "36", security: "WPA3", clients: "8", band: "5GHz" } },
  { id: "2", name: "TP-Link_A7C2", type: "wifi", identifier: "AA:BB:CC:DD:EE:02", signal: -58, firstSeen: "14:22:03", lastSeen: "1s ago", metadata: { channel: "6", security: "WPA2", clients: "3", band: "2.4GHz" } },
  { id: "3", name: "Starlink-2F8A", type: "wifi", identifier: "AA:BB:CC:DD:EE:04", signal: -45, firstSeen: "14:21:55", lastSeen: "1s ago", metadata: { channel: "149", security: "WPA3", clients: "12", band: "5GHz" } },
  { id: "4", name: "AirPods Pro", type: "bluetooth", identifier: "11:22:33:44:55:01", signal: -35, firstSeen: "14:23:10", lastSeen: "1s ago", metadata: { type: "BLE", manufacturer: "Apple", class: "Audio" }, correlated: "AA:BB:CC:DD:EE:01" },
  { id: "5", name: "Galaxy Watch5", type: "bluetooth", identifier: "11:22:33:44:55:02", signal: -52, firstSeen: "14:23:15", lastSeen: "2s ago", metadata: { type: "BLE", manufacturer: "Samsung", class: "Wearable" } },
  { id: "6", name: "JBL Flip 6", type: "bluetooth", identifier: "11:22:33:44:55:04", signal: -61, firstSeen: "14:24:00", lastSeen: "4s ago", metadata: { type: "Classic", manufacturer: "Harman", class: "Audio" } },
  { id: "7", name: "RYR23KP", type: "aircraft", identifier: "4CA87D", signal: -80, firstSeen: "14:20:00", lastSeen: "1s ago", metadata: { altitude: "37,000 ft", speed: "462 kts", heading: "135°", squawk: "7421" } },
  { id: "8", name: "BAW156", type: "aircraft", identifier: "406A3B", signal: -85, firstSeen: "14:19:30", lastSeen: "2s ago", metadata: { altitude: "28,500 ft", speed: "380 kts", heading: "270°", squawk: "3456" } },
  { id: "9", name: "MAERSK SEALAND", type: "vessel", identifier: "MMSI:211234567", signal: -72, firstSeen: "14:15:00", lastSeen: "5s ago", metadata: { type: "Cargo", speed: "12.5 kts", heading: "180°", destination: "ROTTERDAM" } },
  { id: "10", name: "Acurite-5n1", type: "sensor", identifier: "ID:0x1A2B", signal: -65, firstSeen: "14:10:00", lastSeen: "30s ago", metadata: { type: "Weather Station", temperature: "12.3°C", humidity: "67%", protocol: "433MHz" } },
];

const typeConfig: Record<DeviceType, { icon: typeof Wifi; label: string; color: string }> = {
  all: { icon: Cpu, label: "All Devices", color: "text-foreground" },
  wifi: { icon: Wifi, label: "WiFi", color: "text-chart-2" },
  bluetooth: { icon: Bluetooth, label: "Bluetooth", color: "text-primary" },
  aircraft: { icon: Plane, label: "Aircraft", color: "text-chart-5" },
  vessel: { icon: Ship, label: "Vessels", color: "text-chart-2" },
  sensor: { icon: Gauge, label: "Sensors", color: "text-chart-4" },
};

/** Generate a CSV blob from the filtered device list and trigger download */
function exportDevicesCSV(devices: Device[]) {
  if (devices.length === 0) {
    toast.error("No devices to export");
    return;
  }

  const allMetaKeys = Array.from(
    new Set(devices.flatMap((d) => Object.keys(d.metadata)))
  );

  const headers = ["name", "type", "identifier", "signal_dbm", "first_seen", "last_seen", "correlated", ...allMetaKeys];
  const rows = devices.map((d) => [
    d.name,
    d.type,
    d.identifier,
    String(d.signal),
    d.firstSeen,
    d.lastSeen,
    d.correlated || "",
    ...allMetaKeys.map((k) => d.metadata[k] || ""),
  ]);

  const csv = [headers.join(","), ...rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `devices_export_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success(`Exported ${devices.length} devices`, { description: "CSV file downloaded" });
}

function DeviceDrawer({ device, onClose }: { device: Device; onClose: () => void }) {
  const config = typeConfig[device.type];

  return (
    <div className="w-[380px] shrink-0 glass-panel rounded-lg overflow-hidden flex flex-col animate-in slide-in-from-right-4 duration-250">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
        <div className="flex items-center gap-2.5">
          <config.icon className={cn("w-4 h-4", config.color)} />
          <span className="text-sm font-semibold font-display">{device.name}</span>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Identity */}
        <div className="space-y-2">
          <h4 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Identity</h4>
          <div className="space-y-1.5">
            <div className="flex justify-between items-center py-1.5 px-3 rounded bg-muted/20">
              <span className="text-xs font-mono text-muted-foreground">Identifier</span>
              <span className="text-xs font-mono text-foreground">{device.identifier}</span>
            </div>
            <div className="flex justify-between items-center py-1.5 px-3 rounded bg-muted/20">
              <span className="text-xs font-mono text-muted-foreground">Type</span>
              <span className={cn("text-xs font-mono", config.color)}>{config.label}</span>
            </div>
          </div>
        </div>

        {/* Signal */}
        <div className="space-y-2">
          <h4 className="text-xs font-mono text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Signal className="w-3 h-3" /> Signal
          </h4>
          <div className="flex items-center gap-3 py-2 px-3 rounded bg-muted/20">
            <div className="flex-1">
              <div className="h-2 rounded-full bg-muted/30 overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${Math.max(0, Math.min(100, ((device.signal + 90) / 70) * 100))}%` }}
                />
              </div>
            </div>
            <span className="text-sm font-mono text-foreground">{device.signal} dBm</span>
          </div>
        </div>

        {/* Timing */}
        <div className="space-y-2">
          <h4 className="text-xs font-mono text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Clock className="w-3 h-3" /> Timing
          </h4>
          <div className="space-y-1.5">
            <div className="flex justify-between items-center py-1.5 px-3 rounded bg-muted/20">
              <span className="text-xs font-mono text-muted-foreground">First Seen</span>
              <span className="text-xs font-mono text-foreground">{device.firstSeen}</span>
            </div>
            <div className="flex justify-between items-center py-1.5 px-3 rounded bg-muted/20">
              <span className="text-xs font-mono text-muted-foreground">Last Seen</span>
              <span className="text-xs font-mono text-chart-2">{device.lastSeen}</span>
            </div>
          </div>
        </div>

        {/* Metadata */}
        <div className="space-y-2">
          <h4 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Metadata</h4>
          <div className="space-y-1.5">
            {Object.entries(device.metadata).map(([key, value]) => (
              <div key={key} className="flex justify-between items-center py-1.5 px-3 rounded bg-muted/20">
                <span className="text-xs font-mono text-muted-foreground capitalize">{key}</span>
                <span className="text-xs font-mono text-foreground">{value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Correlation */}
        {device.correlated && (
          <div className="space-y-2">
            <h4 className="text-xs font-mono text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Link2 className="w-3 h-3" /> Correlated Device
            </h4>
            <div className="py-2 px-3 rounded bg-primary/5 border border-primary/15">
              <span className="text-xs font-mono text-primary">{device.correlated}</span>
              <p className="text-[10px] font-mono text-muted-foreground mt-1">
                Powered by: device_correlations table (utils/database.py)
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border/30">
        <span className="text-[10px] font-mono text-muted-foreground/60">
          Powered by: DataStore ({device.type === "wifi" ? "wifi_networks" : device.type === "bluetooth" ? "bt_devices" : device.type === "aircraft" ? "adsb_aircraft" : device.type === "vessel" ? "ais_vessels" : "sensor_data"})
        </span>
      </div>
    </div>
  );
}

export default function DevicesPage() {
  const [filter, setFilter] = useState<DeviceType>("all");
  const [search, setSearch] = useState("");
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);

  const filtered = mockDevices.filter((d) => {
    if (filter !== "all" && d.type !== filter) return false;
    if (search && !d.name.toLowerCase().includes(search.toLowerCase()) && !d.identifier.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const counts = {
    all: mockDevices.length,
    wifi: mockDevices.filter((d) => d.type === "wifi").length,
    bluetooth: mockDevices.filter((d) => d.type === "bluetooth").length,
    aircraft: mockDevices.filter((d) => d.type === "aircraft").length,
    vessel: mockDevices.filter((d) => d.type === "vessel").length,
    sensor: mockDevices.filter((d) => d.type === "sensor").length,
  };

  const handleExport = useCallback(() => {
    exportDevicesCSV(filtered);
  }, [filtered]);

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-5rem)]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-display font-bold tracking-wide">Devices</h1>
          <p className="text-sm font-mono text-muted-foreground mt-1">
            {mockDevices.length} devices across {Object.keys(counts).length - 1} categories
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2 text-xs font-mono"
          onClick={handleExport}
        >
          <Download className="w-3 h-3" />
          Export CSV
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1 glass-panel rounded-lg p-1">
          {(Object.keys(typeConfig) as DeviceType[]).map((type) => {
            const cfg = typeConfig[type];
            return (
              <button
                key={type}
                onClick={() => setFilter(type)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mono transition-all",
                  filter === type
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <cfg.icon className={cn("w-3 h-3", filter === type ? cfg.color : "")} />
                {cfg.label}
                <span className="text-[10px] text-muted-foreground ml-1">{counts[type]}</span>
              </button>
            );
          })}
        </div>

        <div className="flex-1 max-w-xs relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search devices..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-8 pl-9 pr-3 rounded-md bg-muted/30 border border-border/50 text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Device table */}
        <GlassPanel
          className="flex-1 min-w-0 flex flex-col"
          noPadding
        >
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs font-mono">
              <thead className="sticky top-0 bg-card/90 backdrop-blur-sm z-10">
                <tr className="border-b border-border/30 text-muted-foreground">
                  <th className="text-left px-4 py-2.5 font-medium w-8"></th>
                  <th className="text-left px-4 py-2.5 font-medium">NAME</th>
                  <th className="text-left px-4 py-2.5 font-medium">IDENTIFIER</th>
                  <th className="text-left px-4 py-2.5 font-medium">SIGNAL</th>
                  <th className="text-left px-4 py-2.5 font-medium">FIRST SEEN</th>
                  <th className="text-left px-4 py-2.5 font-medium">LAST SEEN</th>
                  <th className="text-center px-4 py-2.5 font-medium w-8"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-16 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <div className="w-12 h-12 rounded-lg bg-muted/20 flex items-center justify-center">
                          <AlertCircle className="w-6 h-6 text-muted-foreground/50" />
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">No devices found</p>
                          <p className="text-[11px] font-mono text-muted-foreground/60 mt-1">
                            {search ? `No results for "${search}"` : "Start a scan to detect devices"}
                          </p>
                        </div>
                        {search && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-xs font-mono mt-1"
                            onClick={() => setSearch("")}
                          >
                            Clear search
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  filtered.map((device) => {
                    const cfg = typeConfig[device.type];
                    return (
                      <tr
                        key={device.id}
                        onClick={() => setSelectedDevice(device)}
                        className={cn(
                          "border-b border-border/10 hover:bg-accent/20 transition-colors cursor-pointer",
                          selectedDevice?.id === device.id && "bg-accent/30"
                        )}
                      >
                        <td className="px-4 py-2.5">
                          <cfg.icon className={cn("w-3.5 h-3.5", cfg.color)} />
                        </td>
                        <td className="px-4 py-2.5 text-foreground font-medium">
                          {device.name}
                          {device.correlated && (
                            <Link2 className="w-3 h-3 text-primary inline-block ml-1.5" />
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{device.identifier}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 rounded-full bg-muted/30 overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full transition-all",
                                  device.signal > -50 ? "bg-chart-4" : device.signal > -70 ? "bg-chart-5" : "bg-destructive"
                                )}
                                style={{ width: `${Math.max(5, Math.min(100, ((device.signal + 100) / 70) * 100))}%` }}
                              />
                            </div>
                            <span className={cn(
                              "font-medium",
                              device.signal > -50 ? "text-chart-4" : device.signal > -70 ? "text-chart-5" : "text-destructive"
                            )}>
                              {device.signal} dBm
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{device.firstSeen}</td>
                        <td className="px-4 py-2.5 text-chart-2">{device.lastSeen}</td>
                        <td className="px-4 py-2.5 text-center">
                          <ChevronRight className="w-3 h-3 text-muted-foreground/40" />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </GlassPanel>

        {/* Detail drawer */}
        {selectedDevice && (
          <DeviceDrawer
            device={selectedDevice}
            onClose={() => setSelectedDevice(null)}
          />
        )}
      </div>
    </div>
  );
}
