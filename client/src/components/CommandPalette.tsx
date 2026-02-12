/**
 * CommandPalette — Cmd+K command palette for keyboard-first workflows
 * Powered by: cmdk (already in dependencies)
 * Allows quick navigation to any screen or action
 */
import { useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Command } from "cmdk";
import {
  Radar,
  MonitorDot,
  Cpu,
  Radio,
  Clock,
  Settings,
  Wifi,
  Bluetooth,
  Plane,
  Ship,
  Satellite,
  Shield,
  MessageSquare,
} from "lucide-react";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [, setLocation] = useLocation();

  const navigate = useCallback((path: string) => {
    setLocation(path);
    onOpenChange(false);
  }, [setLocation, onOpenChange]);

  // Escape key handler — works even when focus is outside the Command input
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100]" onClick={() => onOpenChange(false)}>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <Command
          className="glass-panel rounded-lg overflow-hidden shadow-2xl"
          style={{ boxShadow: '0 0 60px oklch(0.7 0.18 285 / 0.15)' }}
        >
          <Command.Input
            placeholder="Search commands, modes, devices..."
            className="w-full h-12 px-4 bg-transparent text-foreground text-sm font-mono border-b border-border/50 outline-none placeholder:text-muted-foreground"
            autoFocus
          />
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground font-mono">
              No results found.
            </Command.Empty>

            <Command.Group heading="Navigation" className="text-xs font-mono text-muted-foreground px-2 py-1.5">
              <Command.Item onSelect={() => navigate("/scan")} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-foreground cursor-pointer data-[selected=true]:bg-accent">
                <Radar className="w-4 h-4 text-primary" /> Scan
              </Command.Item>
              <Command.Item onSelect={() => navigate("/live")} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-foreground cursor-pointer data-[selected=true]:bg-accent">
                <MonitorDot className="w-4 h-4 text-chart-2" /> Live View
              </Command.Item>
              <Command.Item onSelect={() => navigate("/devices")} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-foreground cursor-pointer data-[selected=true]:bg-accent">
                <Cpu className="w-4 h-4 text-primary" /> Devices
              </Command.Item>
              <Command.Item onSelect={() => navigate("/signals")} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-foreground cursor-pointer data-[selected=true]:bg-accent">
                <Radio className="w-4 h-4 text-primary" /> Signals
              </Command.Item>
              <Command.Item onSelect={() => navigate("/history")} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-foreground cursor-pointer data-[selected=true]:bg-accent">
                <Clock className="w-4 h-4 text-primary" /> History
              </Command.Item>
              <Command.Item onSelect={() => navigate("/settings")} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-foreground cursor-pointer data-[selected=true]:bg-accent">
                <Settings className="w-4 h-4 text-primary" /> Settings
              </Command.Item>
            </Command.Group>

            <Command.Separator className="my-1 glass-divider" />

            <Command.Group heading="Scan Modes" className="text-xs font-mono text-muted-foreground px-2 py-1.5">
              <Command.Item onSelect={() => navigate("/scan")} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-foreground cursor-pointer data-[selected=true]:bg-accent">
                <Wifi className="w-4 h-4 text-chart-2" /> WiFi Scan
              </Command.Item>
              <Command.Item onSelect={() => navigate("/scan")} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-foreground cursor-pointer data-[selected=true]:bg-accent">
                <Bluetooth className="w-4 h-4 text-chart-1" /> Bluetooth Scan
              </Command.Item>
              <Command.Item onSelect={() => navigate("/scan")} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-foreground cursor-pointer data-[selected=true]:bg-accent">
                <Plane className="w-4 h-4 text-chart-5" /> ADS-B Aircraft
              </Command.Item>
              <Command.Item onSelect={() => navigate("/scan")} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-foreground cursor-pointer data-[selected=true]:bg-accent">
                <Ship className="w-4 h-4 text-chart-2" /> AIS Vessels
              </Command.Item>
              <Command.Item onSelect={() => navigate("/scan")} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-foreground cursor-pointer data-[selected=true]:bg-accent">
                <Satellite className="w-4 h-4 text-chart-3" /> Satellite
              </Command.Item>
              <Command.Item onSelect={() => navigate("/scan")} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-foreground cursor-pointer data-[selected=true]:bg-accent">
                <Shield className="w-4 h-4 text-destructive" /> TSCM Sweep
              </Command.Item>
              <Command.Item onSelect={() => navigate("/scan")} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-foreground cursor-pointer data-[selected=true]:bg-accent">
                <MessageSquare className="w-4 h-4 text-chart-5" /> Pager / POCSAG
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
