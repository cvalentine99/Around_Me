/**
 * AppShell — Main application layout for Valentine RF - Around Me
 * Design: Obsidian Prism — glassmorphic command center
 * Left nav rail (64px collapsed, 220px expanded on hover)
 * Top header bar with system status
 * Main content area fills remaining space
 */
import { useState, useEffect, type ReactNode } from "react";
import { useLocation, Link } from "wouter";
import {
  Radar,
  MonitorDot,
  Cpu,
  Radio,
  Clock,
  Settings,
  Search,
  Keyboard,
  ChevronRight,
  Zap,
  Shield,
  MapPin,
} from "lucide-react";
import { cn } from "@/lib/utils";
import CommandPalette from "./CommandPalette";

interface NavItem {
  icon: typeof Radar;
  label: string;
  href: string;
  description: string;
}

const navItems: NavItem[] = [
  { icon: Radar, label: "Scan", href: "/scan", description: "Configure & launch scans" },
  { icon: MonitorDot, label: "Live View", href: "/live", description: "Real-time monitoring" },
  { icon: Cpu, label: "Devices", href: "/devices", description: "Detected device inventory" },
  { icon: Radio, label: "Signals", href: "/signals", description: "Signal events & messages" },
  { icon: Clock, label: "History", href: "/history", description: "Past sessions & recordings" },
  { icon: MapPin, label: "Geospatial", href: "/geo", description: "Multi-layer map intelligence" },
  { icon: Settings, label: "Settings", href: "/settings", description: "System configuration" },
];

function NavRail() {
  const [location] = useLocation();
  const [expanded, setExpanded] = useState(false);

  return (
    <nav
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      className={cn(
        "fixed left-0 top-0 bottom-0 z-50 flex flex-col",
        "bg-sidebar/80 backdrop-blur-xl border-r border-sidebar-border",
        "transition-all duration-300 ease-out",
        expanded ? "w-[220px]" : "w-16"
      )}
    >
      {/* Logo */}
      <div className="h-14 flex items-center px-4 border-b border-sidebar-border gap-3">
        <div className="w-8 h-8 rounded-md bg-primary/20 flex items-center justify-center shrink-0">
          <Zap className="w-4 h-4 text-primary" />
        </div>
        <div
          className={cn(
            "overflow-hidden transition-all duration-300",
            expanded ? "w-auto opacity-100" : "w-0 opacity-0"
          )}
        >
          <span className="font-display text-sm font-bold tracking-wider text-foreground whitespace-nowrap">
            VALENTINE RF
          </span>
        </div>
      </div>

      {/* Nav Items */}
      <div className="flex-1 flex flex-col gap-1 py-3 px-2">
        {navItems.map((item) => {
          const isActive =
            location === item.href ||
            (item.href === "/scan" && location === "/");
          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  "flex items-center gap-3 px-3 h-10 rounded-md transition-all duration-200",
                  "group relative",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-primary-foreground"
                    : "text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                )}
              >
                {isActive && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-primary" />
                )}
                <item.icon
                  className={cn(
                    "w-[18px] h-[18px] shrink-0 transition-colors",
                    isActive ? "text-primary" : "group-hover:text-primary/70"
                  )}
                />
                <span
                  className={cn(
                    "text-sm font-medium whitespace-nowrap transition-all duration-300",
                    expanded ? "opacity-100" : "opacity-0 w-0"
                  )}
                >
                  {item.label}
                </span>
                {expanded && isActive && (
                  <ChevronRight className="w-3 h-3 ml-auto text-primary/50" />
                )}
              </div>
            </Link>
          );
        })}
      </div>

      {/* Bottom section */}
      <div className="px-2 pb-3 border-t border-sidebar-border pt-3">
        <div className="flex items-center gap-3 px-3 h-10">
          <div className="w-2 h-2 rounded-full bg-chart-2 pulse-live shrink-0" />
          <span
            className={cn(
              "text-xs font-mono text-muted-foreground whitespace-nowrap transition-all duration-300",
              expanded ? "opacity-100" : "opacity-0 w-0"
            )}
          >
            v2.15.0
          </span>
        </div>
      </div>
    </nav>
  );
}

function TopHeader() {
  const [time, setTime] = useState(new Date());
  const [cmdOpen, setCmdOpen] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const utcStr = time.toISOString().slice(11, 19);

  return (
    <>
      <header className="h-14 flex items-center justify-between px-6 border-b border-border/50 bg-background/50 backdrop-blur-sm">
        <div className="flex items-center gap-4">
          <span className="font-mono text-xs text-muted-foreground tracking-wider">
            UTC {utcStr}
          </span>
          <div className="glass-divider w-px h-5" style={{ background: 'oklch(0.65 0.18 285 / 0.2)' }} />
          <div className="flex items-center gap-2">
            <Shield className="w-3.5 h-3.5 text-chart-2" />
            <span className="text-xs font-mono text-chart-2">STANDBY</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Search / Command Palette trigger */}
          <button
            onClick={() => setCmdOpen(true)}
            className="flex items-center gap-2 h-8 px-3 rounded-md glass-card text-muted-foreground hover:text-foreground text-xs font-mono"
          >
            <Search className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Search...</span>
            <kbd className="hidden sm:flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-muted/50 border border-border/50">
              <Keyboard className="w-2.5 h-2.5" />K
            </kbd>
          </button>

          {/* Status indicators */}
          <div className="flex items-center gap-3 text-xs font-mono text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Radio className="w-3 h-3" />
              <span>0 SDR</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Cpu className="w-3 h-3" />
              <span>0 DEV</span>
            </div>
          </div>
        </div>
      </header>

      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
    </>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background relative">
      {/* Subtle ambient glow in top-right corner */}
      <div
        className="fixed top-0 right-0 w-[600px] h-[600px] pointer-events-none opacity-[0.03] z-0"
        style={{
          background: 'radial-gradient(circle at 80% 20%, oklch(0.7 0.25 285), transparent 60%)',
        }}
      />
      <NavRail />
      <div className="ml-16 flex flex-col min-h-screen relative z-10">
        <TopHeader />
        <main className="flex-1 p-4 lg:p-6 2xl:p-8">{children}</main>
      </div>
    </div>
  );
}
