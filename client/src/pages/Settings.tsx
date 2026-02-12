/**
 * Settings Page — Centralized system configuration
 * Design: Obsidian Prism — sectioned settings with glass panels
 * 
 * Powered by:
 *   General settings → routes/settings.py (settings table)
 *   SDR devices → GET /devices/status (app.py)
 *   Alert rules → routes/alerts.py (alert_rules table)
 *   User accounts → users table (utils/database.py)
 *   GPS config → routes/gps.py
 *   Offline mode → routes/offline.py
 *   Updates → routes/updater.py
 */
import { useState, useCallback } from "react";
import {
  Settings as SettingsIcon,
  Radio,
  Bell,
  User,
  MapPin,
  WifiOff,
  RefreshCw,
  Shield,
  Database,
  Monitor,
  Save,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import GlassPanel from "@/components/GlassPanel";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface SettingsSection {
  id: string;
  icon: typeof SettingsIcon;
  label: string;
  description: string;
  poweredBy: string;
}

const sections: SettingsSection[] = [
  { id: "general", icon: SettingsIcon, label: "General", description: "Application name, theme, and display preferences", poweredBy: "routes/settings.py" },
  { id: "sdr", icon: Radio, label: "SDR Devices", description: "Hardware configuration and device management", poweredBy: "GET /devices/status (app.py)" },
  { id: "alerts", icon: Bell, label: "Alert Rules", description: "Configure alert triggers and webhook notifications", poweredBy: "routes/alerts.py" },
  { id: "users", icon: User, label: "User Accounts", description: "Manage user access and authentication", poweredBy: "users table (utils/database.py)" },
  { id: "gps", icon: MapPin, label: "GPS", description: "GPS receiver configuration and location settings", poweredBy: "routes/gps.py" },
  { id: "tscm", icon: Shield, label: "TSCM", description: "Counter-surveillance baselines and scheduling", poweredBy: "routes/tscm.py" },
  { id: "offline", icon: WifiOff, label: "Offline Mode", description: "Offline data caching and sync settings", poweredBy: "routes/offline.py" },
  { id: "display", icon: Monitor, label: "Display", description: "Map tiles, units, and visualization preferences", poweredBy: "routes/settings.py" },
  { id: "database", icon: Database, label: "Database", description: "SQLite database management and data retention", poweredBy: "utils/database.py" },
  { id: "updates", icon: RefreshCw, label: "Updates", description: "Check for application updates from GitHub", poweredBy: "routes/updater.py" },
];

/** Toggle component that actually maintains state */
function Toggle({ defaultValue, label, description, onChange }: {
  defaultValue: boolean;
  label: string;
  description: string;
  onChange?: (value: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(defaultValue);

  const handleToggle = () => {
    const next = !enabled;
    setEnabled(next);
    onChange?.(next);
  };

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded bg-muted/15">
      <div>
        <span className="text-sm text-foreground">{label}</span>
        <p className="text-[11px] font-mono text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={handleToggle}
        className={cn(
          "w-10 h-5 rounded-full transition-colors relative shrink-0",
          enabled ? "bg-primary" : "bg-muted"
        )}
      >
        <div
          className={cn(
            "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform",
            enabled ? "translate-x-5" : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  );
}

function GeneralSettings({ settings, onUpdate }: {
  settings: Record<string, string>;
  onUpdate: (key: string, value: string) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <h3 className="text-sm font-display font-semibold">Application</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">App Name</label>
            <input
              type="text"
              value={settings.appName || "Valentine RF"}
              onChange={(e) => onUpdate("appName", e.target.value)}
              className="w-full h-10 px-3 rounded-md bg-muted/30 border border-border/50 text-sm font-mono text-foreground outline-none focus:border-primary/50 transition-colors"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Version</label>
            <div className="h-10 px-3 rounded-md bg-muted/20 border border-border/30 flex items-center text-sm font-mono text-muted-foreground">
              2.15.0
            </div>
          </div>
        </div>
      </div>

      <div className="glass-divider" />

      <div className="space-y-4">
        <h3 className="text-sm font-display font-semibold">Display</h3>
        <div className="space-y-3">
          <Toggle defaultValue={true} label="Dark Mode" description="Use dark theme (recommended)" onChange={(v) => onUpdate("darkMode", String(v))} />
          <Toggle defaultValue={true} label="Show UTC Time" description="Display UTC timestamps in header" onChange={(v) => onUpdate("utcTime", String(v))} />
          <Toggle defaultValue={true} label="Monospace Data" description="Use monospace font for data tables" onChange={(v) => onUpdate("monoData", String(v))} />
          <Toggle defaultValue={false} label="Auto-scroll Live View" description="Auto-scroll signal feed" onChange={(v) => onUpdate("autoScroll", String(v))} />
        </div>
      </div>

      <div className="glass-divider" />

      <div className="space-y-4">
        <h3 className="text-sm font-display font-semibold">Data Retention</h3>
        <div className="grid grid-cols-2 gap-4">
          {[
            { label: "WiFi Network Age", value: "300", key: "MAX_WIFI_NETWORK_AGE_SECONDS", unit: "s" },
            { label: "BT Device Age", value: "120", key: "MAX_BT_DEVICE_AGE_SECONDS", unit: "s" },
            { label: "Aircraft Age", value: "60", key: "MAX_AIRCRAFT_AGE_SECONDS", unit: "s" },
            { label: "Vessel Age", value: "300", key: "MAX_VESSEL_AGE_SECONDS", unit: "s" },
          ].map((item) => (
            <div key={item.key} className="space-y-2">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{item.label}</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={settings[item.key] || item.value}
                  onChange={(e) => onUpdate(item.key, e.target.value)}
                  className="flex-1 h-10 px-3 rounded-md bg-muted/30 border border-border/50 text-sm font-mono text-foreground outline-none focus:border-primary/50 transition-colors"
                />
                <span className="text-xs font-mono text-muted-foreground">{item.unit}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SDRSettings() {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const resp = await fetch("/devices/status");
      if (resp.ok) {
        toast.success("Device status refreshed", { description: "GET /devices/status" });
      } else {
        toast.error("Failed to refresh devices", { description: `${resp.status} ${resp.statusText}` });
      }
    } catch {
      toast.error("Backend unreachable", { description: "Could not connect to /devices/status" });
    } finally {
      setRefreshing(false);
    }
  }, []);

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-display font-semibold">Connected Devices</h3>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 text-xs font-mono"
            disabled={refreshing}
            onClick={handleRefresh}
          >
            {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh
          </Button>
        </div>

        <div className="space-y-2">
          {[
            { name: "RTL-SDR", type: "rtlsdr", serial: "00000001", status: "available", file: "utils/rtlsdr.py" },
            { name: "HackRF One", type: "hackrf", serial: "—", status: "not found", file: "utils/hackrf.py" },
            { name: "Airspy Mini", type: "airspy", serial: "—", status: "not found", file: "utils/airspy.py" },
            { name: "LimeSDR", type: "limesdr", serial: "—", status: "not found", file: "utils/limesdr.py" },
            { name: "SDRplay", type: "sdrplay", serial: "—", status: "not found", file: "utils/sdrplay.py" },
          ].map((device) => (
            <div key={device.type} className="flex items-center gap-4 py-3 px-4 rounded-lg bg-muted/15 border border-border/20">
              <div className={cn(
                "w-2 h-2 rounded-full shrink-0",
                device.status === "available" ? "bg-chart-4" : "bg-muted-foreground/30"
              )} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{device.name}</span>
                  <span className={cn(
                    "px-1.5 py-0.5 rounded text-[9px] font-mono",
                    device.status === "available" ? "bg-chart-4/10 text-chart-4" : "bg-muted text-muted-foreground"
                  )}>
                    {device.status.toUpperCase()}
                  </span>
                </div>
                <span className="text-[11px] font-mono text-muted-foreground">
                  Serial: {device.serial} · {device.file}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="glass-divider" />

      <div className="space-y-4">
        <h3 className="text-sm font-display font-semibold">Remote SDR</h3>
        <div className="space-y-3">
          <div className="space-y-2">
            <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">rtl_tcp Host</label>
            <input
              type="text"
              placeholder="127.0.0.1"
              className="w-full h-10 px-3 rounded-md bg-muted/30 border border-border/50 text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">rtl_tcp Port</label>
            <input
              type="text"
              placeholder="1234"
              className="w-full h-10 px-3 rounded-md bg-muted/30 border border-border/50 text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function AlertSettings() {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-display font-semibold">Alert Rules</h3>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 text-xs font-mono"
            onClick={() => toast.info("Add Rule", { description: "Feature coming soon — POST /alerts/rules" })}
          >
            + Add Rule
          </Button>
        </div>
        <div className="space-y-2">
          {[
            { name: "WiFi Deauth Detection", type: "wifi", condition: "deauth_count > 10" },
            { name: "New Aircraft ICAO", type: "adsb", condition: "icao NOT IN known_list" },
            { name: "BT Device Proximity", type: "bluetooth", condition: "rssi > -30 dBm" },
            { name: "DSC Distress Alert", type: "dsc", condition: "nature = DISTRESS" },
          ].map((rule) => (
            <AlertRuleRow key={rule.name} name={rule.name} type={rule.type} condition={rule.condition} />
          ))}
        </div>
      </div>

      <div className="glass-divider" />

      <div className="space-y-4">
        <h3 className="text-sm font-display font-semibold">Webhook</h3>
        <div className="space-y-2">
          <input
            type="text"
            placeholder="https://hooks.example.com/alerts"
            className="w-full h-10 px-3 rounded-md bg-muted/30 border border-border/50 text-sm font-mono text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors"
          />
          <p className="text-[11px] font-mono text-muted-foreground">
            Powered by: routes/alerts.py — POST webhook on alert trigger
          </p>
        </div>
      </div>
    </div>
  );
}

function AlertRuleRow({ name, type, condition }: { name: string; type: string; condition: string }) {
  const [enabled, setEnabled] = useState(true);

  return (
    <div className="flex items-center gap-4 py-3 px-4 rounded-lg bg-muted/15 border border-border/20">
      <button
        type="button"
        onClick={() => setEnabled(!enabled)}
        className={cn(
          "w-2 h-2 rounded-full shrink-0 transition-colors",
          enabled ? "bg-chart-4" : "bg-muted-foreground/30"
        )}
        title={enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
      />
      <div className="flex-1">
        <span className="text-sm font-medium text-foreground">{name}</span>
        <div className="text-[11px] font-mono text-muted-foreground mt-0.5">
          {condition}
        </div>
      </div>
      <span className="text-[10px] font-mono text-muted-foreground">{type}</span>
    </div>
  );
}

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState("general");
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<Record<string, string>>({
    appName: "Valentine RF",
  });
  const [dirty, setDirty] = useState(false);

  const handleUpdate = useCallback((key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const resp = await fetch("/settings/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (resp.ok) {
        toast.success("Settings saved", { description: "POST /settings/save" });
        setDirty(false);
      } else {
        toast.error("Failed to save settings", { description: `${resp.status} ${resp.statusText}` });
      }
    } catch {
      toast.error("Backend unreachable", { description: "Could not connect to /settings/save" });
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const renderContent = () => {
    switch (activeSection) {
      case "general": return <GeneralSettings settings={settings} onUpdate={handleUpdate} />;
      case "sdr": return <SDRSettings />;
      case "alerts": return <AlertSettings />;
      default:
        const section = sections.find(s => s.id === activeSection);
        return (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
              {section && <section.icon className="w-6 h-6 text-primary" />}
            </div>
            <h3 className="text-sm font-display font-semibold mb-1">{section?.label}</h3>
            <p className="text-xs font-mono text-muted-foreground max-w-sm">
              {section?.description}
            </p>
            <p className="text-[10px] font-mono text-muted-foreground/50 mt-3">
              Powered by: {section?.poweredBy}
            </p>
          </div>
        );
    }
  };

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-5rem)]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-display font-bold tracking-wide">Settings</h1>
          <p className="text-sm font-mono text-muted-foreground mt-1">
            System configuration and device management
          </p>
        </div>
        <Button
          className="gap-2 text-xs font-mono"
          disabled={saving || !dirty}
          onClick={handleSave}
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          {saving ? "Saving..." : dirty ? "Save Changes" : "Saved"}
        </Button>
      </div>

      {/* Content */}
      <div className="flex gap-6 flex-1 min-h-0">
        {/* Section list */}
        <div className="w-[260px] shrink-0 space-y-1 overflow-y-auto">
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all",
                activeSection === section.id
                  ? "glass-panel"
                  : "hover:bg-accent/20"
              )}
            >
              <section.icon className={cn(
                "w-4 h-4 shrink-0",
                activeSection === section.id ? "text-primary" : "text-muted-foreground"
              )} />
              <div className="flex-1 min-w-0">
                <span className={cn(
                  "text-sm font-medium block",
                  activeSection === section.id ? "text-foreground" : "text-muted-foreground"
                )}>
                  {section.label}
                </span>
              </div>
              {activeSection === section.id && (
                <ChevronRight className="w-3 h-3 text-primary/50 shrink-0" />
              )}
            </button>
          ))}
        </div>

        {/* Settings content */}
        <GlassPanel className="flex-1 min-w-0 overflow-y-auto" poweredBy={sections.find(s => s.id === activeSection)?.poweredBy}>
          {renderContent()}
        </GlassPanel>
      </div>
    </div>
  );
}
