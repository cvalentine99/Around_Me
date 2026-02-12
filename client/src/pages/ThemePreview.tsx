/*
 * OBSIDIAN PRISM — Theme Preview
 * Design: Purple glassmorphic dark-first command center aesthetic
 * Typography: Space Grotesk (display) + IBM Plex Mono (data)
 * This page showcases every UI component used in the Valentine RF - Around Me platform
 */

import { useState } from "react";
import {
  Radio, Wifi, Bluetooth, Shield, Radar, Activity, Signal,
  Cpu, Database, Terminal, AlertTriangle, CheckCircle2, XCircle,
  ChevronDown, ChevronRight, Search, Settings, Zap, Eye,
  Clock, Download, Upload, Play, Square, RotateCcw,
  Monitor, Antenna, Plane, Ship, Satellite, Waves,
  Lock, Unlock, Globe, MapPin, Thermometer, Volume2,
  BarChart3, PieChart, TrendingUp, Layers, Grid3x3,
  Moon, Sun, Palette, Sparkles, Box, Hexagon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const HERO_IMAGE = "https://private-us-east-1.manuscdn.com/sessionFile/Kyh9m5QJIofvIpkWX8g2Gh/sandbox/NNkvYcbpqtauqwU08kL6kR-img-1_1770751894000_na1fn_aGVyby1yZi1zcGVjdHJ1bQ.png?x-oss-process=image/resize,w_1920,h_1920/format,webp/quality,q_80&Expires=1798761600&Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9wcml2YXRlLXVzLWVhc3QtMS5tYW51c2Nkbi5jb20vc2Vzc2lvbkZpbGUvS3loOW01UUpJb2Z2SXBrV1g4ZzJHaC9zYW5kYm94L05Oa3ZZY2JwcXRhdXF3VTA4a0w2a1ItaW1nLTFfMTc3MDc1MTg5NDAwMF9uYTFmbl9hR1Z5YnkxeVppMXpjR1ZqZEhKMWJRLnBuZz94LW9zcy1wcm9jZXNzPWltYWdlL3Jlc2l6ZSx3XzE5MjAsaF8xOTIwL2Zvcm1hdCx3ZWJwL3F1YWxpdHkscV84MCIsIkNvbmRpdGlvbiI6eyJEYXRlTGVzc1RoYW4iOnsiQVdTOkVwb2NoVGltZSI6MTc5ODc2MTYwMH19fV19&Key-Pair-Id=K2HSFNDJXOU9YS&Signature=tlN-by0xfgvJMN-C7OdRFH6O5zi8m~Du-zOTe12a6CLPRN2VS-gqZAlBgkFIGVweWzT8nqTfZms9rbaI2FFMsehwpApO73XUadigkvrP6E0ZRod6KeL7RWHSYt~WDLOYdCCJYdJpWfpukGIJH4iyFMZvX-zuOCcgjtZzhAnrzXqMYoHwSIf9camf3SHqysWexgCevrOiUunpzHmOFRzqkNN-YPJiR6WROgCCFFI0y1PEGKkdfAZuVXcRE7UBOfJBjKx9AjFnUo~giBhvhZkcXOatl2UNwdKKXWzQJheD9eN3MY5zCcSTXqiPsAObSWqmpO-aM7KR8NF~VHZedHoiJg__";
const SIGNAL_IMAGE = "https://private-us-east-1.manuscdn.com/sessionFile/Kyh9m5QJIofvIpkWX8g2Gh/sandbox/NNkvYcbpqtauqwU08kL6kR-img-2_1770751898000_na1fn_aGVyby1zaWduYWwtd2F2ZQ.png?x-oss-process=image/resize,w_1920,h_1920/format,webp/quality,q_80&Expires=1798761600&Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9wcml2YXRlLXVzLWVhc3QtMS5tYW51c2Nkbi5jb20vc2Vzc2lvbkZpbGUvS3loOW01UUpJb2Z2SXBrV1g4ZzJHaC9zYW5kYm94L05Oa3ZZY2JwcXRhdXF3VTA4a0w2a1ItaW1nLTJfMTc3MDc1MTg5ODAwMF9uYTFmbl9hR1Z5YnkxemFXZHVZV3d0ZDJGMlpRLnBuZz94LW9zcy1wcm9jZXNzPWltYWdlL3Jlc2l6ZSx3XzE5MjAsaF8xOTIwL2Zvcm1hdCx3ZWJwL3F1YWxpdHkscV84MCIsIkNvbmRpdGlvbiI6eyJEYXRlTGVzc1RoYW4iOnsiQVdTOkVwb2NoVGltZSI6MTc5ODc2MTYwMH19fV19&Key-Pair-Id=K2HSFNDJXOU9YS&Signature=ri~rv15MN8lMv552sVd~NAdssHpO6oZnFcwzEFoDIRsr4LZmKp70JUCSBCEUrydPtdqXGKBJ98IicfHaxkFM4japffYTfG~VDVSDYoHk6F9y732U9s43buPGRceFZ3PAiZleyaHaK5WEMycntF0eE1jmJ~ywWUGaItAT8K1TyJw1VzkxSH9Go0f-5r4GBVlBfCWX29P-OhYFl7eMVpO6zYI1sve-9ruEqy9svycVbsPmy4kxcMKHc4Ll4BLcXw-G2wkR-GBp4VHqKHmF0r9Q4ZPFhuiydNuq2dQg-HkIrV0fo5sjA09dZd9bOJyrfKK5NRfSpL6MLq8omPV7izCAIA__";
const NETWORK_IMAGE = "https://private-us-east-1.manuscdn.com/sessionFile/Kyh9m5QJIofvIpkWX8g2Gh/sandbox/NNkvYcbpqtauqwU08kL6kR-img-3_1770751899000_na1fn_aGVyby1uZXR3b3JrLXRvcG9sb2d5.png?x-oss-process=image/resize,w_1920,h_1920/format,webp/quality,q_80&Expires=1798761600&Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9wcml2YXRlLXVzLWVhc3QtMS5tYW51c2Nkbi5jb20vc2Vzc2lvbkZpbGUvS3loOW01UUpJb2Z2SXBrV1g4ZzJHaC9zYW5kYm94L05Oa3ZZY2JwcXRhdXF3VTA4a0w2a1ItaW1nLTNfMTc3MDc1MTg5OTAwMF9uYTFmbl9hR1Z5YnkxdVpYUjNiM0pyTFhSdmNHOXNiMmQ1LnBuZz94LW9zcy1wcm9jZXNzPWltYWdlL3Jlc2l6ZSx3XzE5MjAsaF8xOTIwL2Zvcm1hdCx3ZWJwL3F1YWxpdHkscV84MCIsIkNvbmRpdGlvbiI6eyJEYXRlTGVzc1RoYW4iOnsiQVdTOkVwb2NoVGltZSI6MTc5ODc2MTYwMH19fV19&Key-Pair-Id=K2HSFNDJXOU9YS&Signature=Pz0ru6RSGVZ727eyxIZ6yTvquPVdZ5J3f80g7dXKyWKEs8a99HUFA7p0bhh0YAvfSeyVq1DpY8V09i7Ylc3g-TN~Voh5~4fWL-pNz1h0ny4gNGQ5QaV7etkvcNIIyqDkC~D4bIUw2dfjaN0I2CQFQPg0rrferOEwik1Ad2latIWdTxQ6~3u-Flfg4KIFvM1ZaztuJUwxxmbCOoNLckbOhkFpMr-sVDH1Nubj2oucV5sLFV~a2ZUrc4ME8PTwbcwHZceRUXnX4GDm4wiWmGwd-AynpVje8uiMFB5J~z7qQn55D9vK~2HRouWr9tBv8JqDilOL0F98zjalDLIwv8XpTQ__";
const SCAN_BG = "https://private-us-east-1.manuscdn.com/sessionFile/Kyh9m5QJIofvIpkWX8g2Gh/sandbox/NNkvYcbpqtauqwU08kL6kR-img-4_1770751897000_na1fn_c2Nhbi1tb2RlLWJn.png?x-oss-process=image/resize,w_1920,h_1920/format,webp/quality,q_80&Expires=1798761600&Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9wcml2YXRlLXVzLWVhc3QtMS5tYW51c2Nkbi5jb20vc2Vzc2lvbkZpbGUvS3loOW01UUpJb2Z2SXBrV1g4ZzJHaC9zYW5kYm94L05Oa3ZZY2JwcXRhdXF3VTA4a0w2a1ItaW1nLTRfMTc3MDc1MTg5NzAwMF9uYTFmbl9jMk5oYmkxdGIyUmxMV0puLnBuZz94LW9zcy1wcm9jZXNzPWltYWdlL3Jlc2l6ZSx3XzE5MjAsaF8xOTIwL2Zvcm1hdCx3ZWJwL3F1YWxpdHkscV84MCIsIkNvbmRpdGlvbiI6eyJEYXRlTGVzc1RoYW4iOnsiQVdTOkVwb2NoVGltZSI6MTc5ODc2MTYwMH19fV19&Key-Pair-Id=K2HSFNDJXOU9YS&Signature=vO2Tcf2K43LP4DnM0fEU1u4EaBre5vtikwtZ1lqGNRBS9Ea0OV8E2BlXHm9T783Dtxxrry22KexMPjlSbt-i-7nqji6ueR~cqnQ6JKO-m1TL2ihdhDBTd9deFm31VJShpeDIUFIgKb9nDHgOXOoWygNFgBQewQzJNVQ263ynUtaatAgpCZDIRVSbpJj81Qby-bF2P-0QnkOcEpETIHXFj--TLeSialwPgvgjedoxKIHltsmrZokYxBZVDVO4OQ~8nCggllqfWzsl2l1aa7qFrAiQUFLaNY0K8xnCkGS8gWl9QoTIHmrhkS4HzzX8xJVhPbh1C6dg4lQZ0~NVsLSjVg__";

/* ─── Section wrapper ─── */
function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="mb-16">
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold tracking-tight text-foreground glow-text">{title}</h2>
        {subtitle && <p className="text-sm text-muted-foreground font-mono mt-1">{subtitle}</p>}
        <div className="glass-divider mt-3" />
      </div>
      {children}
    </section>
  );
}

/* ─── Glass panel wrapper ─── */
function GlassDemo({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`glass-panel rounded-md p-5 ${className || ""}`}>
      <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-mono block mb-3">{label}</span>
      {children}
    </div>
  );
}

/* ─── Signal strength bar ─── */
function SignalBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = (value / max) * 100;
  const color = pct > 70 ? "bg-emerald-400" : pct > 40 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-muted-foreground">{value}dBm</span>
    </div>
  );
}

/* ─── Fake waterfall row ─── */
function WaterfallRow({ seed }: { seed: number }) {
  const cells = Array.from({ length: 64 }, (_, i) => {
    const noise = Math.sin(seed * 0.3 + i * 0.5) * 0.5 + 0.5;
    const signal = (i > 20 && i < 28) ? Math.max(noise, 0.7 + Math.sin(seed * 0.1 + i) * 0.3) : noise;
    const alpha = Math.max(0.02, signal * 0.8);
    const hue = signal > 0.6 ? `oklch(0.7 0.18 285 / ${alpha})` : `oklch(0.5 0.1 285 / ${alpha * 0.5})`;
    return <div key={i} className="h-1" style={{ background: hue, flex: 1 }} />;
  });
  return <div className="flex">{cells}</div>;
}

/* ─── Color swatch ─── */
function Swatch({ name, value, textClass }: { name: string; value: string; textClass?: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-md border border-border/50 shrink-0" style={{ background: value }} />
      <div>
        <p className={`text-xs font-mono ${textClass || "text-foreground"}`}>{name}</p>
        <p className="text-[10px] font-mono text-muted-foreground">{value}</p>
      </div>
    </div>
  );
}

export default function ThemePreview() {
  const [scanActive, setScanActive] = useState(false);
  const [selectedMode, setSelectedMode] = useState("pager");

  return (
    <div className="min-h-screen">
      {/* ═══════════════════════════════════════════════════════════════
          HERO BANNER
      ═══════════════════════════════════════════════════════════════ */}
      <div className="relative overflow-hidden mb-12">
        <div className="absolute inset-0">
          <img src={HERO_IMAGE} alt="" className="w-full h-full object-cover opacity-20" />
          <div className="absolute inset-0 bg-gradient-to-b from-background/40 via-background/80 to-background" />
        </div>
        <div className="relative px-8 py-16 max-w-7xl mx-auto">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-md bg-primary/20 border border-primary/30 flex items-center justify-center">
              <Radar className="w-5 h-5 text-primary" />
            </div>
            <Badge variant="outline" className="font-mono text-[10px] tracking-widest border-primary/30 text-primary">
              OBSIDIAN PRISM v1.0
            </Badge>
          </div>
          <h1 className="font-display text-5xl font-bold tracking-tight mb-3">
            <span className="text-foreground">Valentine RF</span>
            <span className="text-muted-foreground font-light ml-3">//</span>
            <span className="text-primary ml-3">Theme Preview</span>
          </h1>
          <p className="text-muted-foreground font-mono text-sm max-w-2xl leading-relaxed">
            Comprehensive showcase of the Obsidian Prism purple glass design system.
            Every component, color, animation, and glass effect used across the Valentine RF
            signal intelligence platform.
          </p>
          <div className="flex gap-3 mt-6">
            <Badge className="bg-primary/10 text-primary border border-primary/20 font-mono text-[10px]">
              <Moon className="w-3 h-3 mr-1" /> DARK-FIRST
            </Badge>
            <Badge className="bg-primary/10 text-primary border border-primary/20 font-mono text-[10px]">
              <Sparkles className="w-3 h-3 mr-1" /> GLASSMORPHIC
            </Badge>
            <Badge className="bg-primary/10 text-primary border border-primary/20 font-mono text-[10px]">
              <Hexagon className="w-3 h-3 mr-1" /> SPACE GROTESK + IBM PLEX MONO
            </Badge>
          </div>
        </div>
      </div>

      <div className="px-8 max-w-7xl mx-auto pb-20">

        {/* ═══════════════════════════════════════════════════════════════
            1. COLOR PALETTE
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="Color Palette" subtitle="oklch-based design tokens — purple-dominant with functional accents">
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-4">
            <GlassDemo label="Background">
              <Swatch name="--background" value="oklch(0.08 0.02 290)" />
            </GlassDemo>
            <GlassDemo label="Primary">
              <Swatch name="--primary" value="oklch(0.7 0.18 285)" />
            </GlassDemo>
            <GlassDemo label="Card">
              <Swatch name="--card" value="oklch(0.14 0.025 285 / 0.6)" />
            </GlassDemo>
            <GlassDemo label="Muted">
              <Swatch name="--muted" value="oklch(0.2 0.02 285)" />
            </GlassDemo>
            <GlassDemo label="Destructive">
              <Swatch name="--destructive" value="oklch(0.6 0.22 25)" />
            </GlassDemo>
            <GlassDemo label="Ring / Focus">
              <Swatch name="--ring" value="oklch(0.7 0.18 285)" />
            </GlassDemo>
          </div>

          <div className="mt-6">
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-mono block mb-3">Chart Colors</span>
            <div className="flex gap-2 items-end h-24">
              {[
                { label: "chart-1", h: "100%", color: "oklch(0.7 0.18 285)" },
                { label: "chart-2", h: "80%", color: "oklch(0.78 0.15 195)" },
                { label: "chart-3", h: "65%", color: "oklch(0.65 0.2 330)" },
                { label: "chart-4", h: "50%", color: "oklch(0.7 0.15 145)" },
                { label: "chart-5", h: "35%", color: "oklch(0.75 0.18 60)" },
              ].map((bar) => (
                <Tooltip key={bar.label}>
                  <TooltipTrigger asChild>
                    <div className="flex-1 rounded-t-sm transition-all hover:opacity-80 cursor-default" style={{ height: bar.h, background: bar.color, minWidth: 32 }} />
                  </TooltipTrigger>
                  <TooltipContent><span className="font-mono text-xs">{bar.label}: {bar.color}</span></TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            2. TYPOGRAPHY
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="Typography" subtitle="Space Grotesk (display) + IBM Plex Mono (data/body)">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <GlassDemo label="Display Font — Space Grotesk">
              <div className="space-y-3">
                <p className="font-display text-4xl font-bold tracking-tight text-foreground">Signal Intelligence</p>
                <p className="font-display text-2xl font-semibold text-foreground/80">Counter Surveillance</p>
                <p className="font-display text-lg font-medium text-muted-foreground">RF Reconnaissance Platform</p>
                <p className="font-display text-sm text-muted-foreground">ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789</p>
              </div>
            </GlassDemo>
            <GlassDemo label="Mono Font — IBM Plex Mono">
              <div className="space-y-3">
                <p className="font-mono text-lg text-foreground">freq: 462.5625 MHz</p>
                <p className="font-mono text-sm text-foreground/80">BSSID: AA:BB:CC:DD:EE:FF</p>
                <p className="font-mono text-xs text-muted-foreground">ICAO: A4B2C8 | SQUAWK: 7700</p>
                <p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
                  abcdefghijklmnopqrstuvwxyz 0123456789 !@#$%
                </p>
              </div>
            </GlassDemo>
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            3. GLASS SURFACES
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="Glass Surfaces" subtitle="Three tiers of glassmorphic depth — panel, card, elevated">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="glass-panel rounded-md p-6 space-y-3">
              <span className="text-[10px] uppercase tracking-[0.2em] text-primary font-mono">.glass-panel</span>
              <p className="text-sm text-foreground">Primary surface. Used for sidebars, main content panels, and configuration areas.</p>
              <code className="text-[10px] font-mono text-muted-foreground block">
                backdrop-filter: blur(24px) saturate(1.2)<br />
                background: oklch(0.12 0.025 285 / 0.55)
              </code>
            </div>
            <div className="glass-card rounded-md p-6 space-y-3">
              <span className="text-[10px] uppercase tracking-[0.2em] text-primary font-mono">.glass-card</span>
              <p className="text-sm text-foreground">Secondary surface. Used for device cards, signal entries, and data rows.</p>
              <code className="text-[10px] font-mono text-muted-foreground block">
                backdrop-filter: blur(16px) saturate(1.1)<br />
                background: oklch(0.1 0.02 285 / 0.45)
              </code>
            </div>
            <div className="glass-elevated rounded-md p-6 space-y-3">
              <span className="text-[10px] uppercase tracking-[0.2em] text-primary font-mono">.glass-elevated</span>
              <p className="text-sm text-foreground">Elevated surface. Used for modals, command palette, and detail drawers.</p>
              <code className="text-[10px] font-mono text-muted-foreground block">
                backdrop-filter: blur(32px) saturate(1.4)<br />
                background: oklch(0.14 0.03 285 / 0.75)
              </code>
            </div>
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            4. BUTTONS & CONTROLS
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="Buttons & Controls" subtitle="Action hierarchy — primary, secondary, outline, destructive, ghost">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <GlassDemo label="Button Variants">
              <div className="flex flex-wrap gap-3">
                <Button><Play className="w-4 h-4 mr-2" /> Start Scan</Button>
                <Button variant="secondary"><Settings className="w-4 h-4 mr-2" /> Configure</Button>
                <Button variant="outline"><Download className="w-4 h-4 mr-2" /> Export</Button>
                <Button variant="destructive"><Square className="w-4 h-4 mr-2" /> Kill Process</Button>
                <Button variant="ghost"><RotateCcw className="w-4 h-4 mr-2" /> Reset</Button>
              </div>
              <div className="flex flex-wrap gap-3 mt-4">
                <Button size="sm">Small</Button>
                <Button size="default">Default</Button>
                <Button size="lg">Large</Button>
                <Button size="icon"><Zap className="w-4 h-4" /></Button>
              </div>
            </GlassDemo>
            <GlassDemo label="Form Controls">
              <div className="space-y-4">
                <div className="flex items-center gap-4">
                  <Input placeholder="Search frequency..." className="max-w-xs" />
                  <Button size="icon" variant="outline"><Search className="w-4 h-4" /></Button>
                </div>
                <div className="flex items-center gap-4">
                  <Select defaultValue="rtlsdr">
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rtlsdr">RTL-SDR</SelectItem>
                      <SelectItem value="hackrf">HackRF</SelectItem>
                      <SelectItem value="limesdr">LimeSDR</SelectItem>
                      <SelectItem value="airspy">Airspy</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-2">
                    <Switch id="biast" />
                    <label htmlFor="biast" className="text-xs font-mono text-muted-foreground">Bias-T</label>
                  </div>
                </div>
              </div>
            </GlassDemo>
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            5. BADGES & STATUS INDICATORS
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="Badges & Status" subtitle="Scan states, protocol tags, threat levels, and signal quality indicators">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <GlassDemo label="Scan States">
              <div className="flex flex-wrap gap-2">
                <Badge className="bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse" /> SCANNING
                </Badge>
                <Badge className="bg-amber-500/20 text-amber-400 border border-amber-500/30">
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-400 mr-1.5" /> IDLE
                </Badge>
                <Badge className="bg-red-500/20 text-red-400 border border-red-500/30">
                  <div className="w-1.5 h-1.5 rounded-full bg-red-400 mr-1.5" /> ERROR
                </Badge>
                <Badge className="bg-primary/20 text-primary border border-primary/30">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mr-1.5" /> PROCESSING
                </Badge>
              </div>
            </GlassDemo>
            <GlassDemo label="Protocol Tags">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className="font-mono text-[10px]"><Wifi className="w-3 h-3 mr-1" /> WiFi</Badge>
                <Badge variant="outline" className="font-mono text-[10px]"><Bluetooth className="w-3 h-3 mr-1" /> BLE</Badge>
                <Badge variant="outline" className="font-mono text-[10px]"><Radio className="w-3 h-3 mr-1" /> POCSAG</Badge>
                <Badge variant="outline" className="font-mono text-[10px]"><Plane className="w-3 h-3 mr-1" /> ADS-B</Badge>
                <Badge variant="outline" className="font-mono text-[10px]"><Ship className="w-3 h-3 mr-1" /> AIS</Badge>
                <Badge variant="outline" className="font-mono text-[10px]"><Satellite className="w-3 h-3 mr-1" /> SAT</Badge>
              </div>
            </GlassDemo>
            <GlassDemo label="TSCM Threat Levels">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-emerald-400" />
                  <span className="text-xs font-mono text-emerald-400">CLEAR</span>
                  <span className="text-[10px] text-muted-foreground ml-auto">No threats detected</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-amber-400" />
                  <span className="text-xs font-mono text-amber-400">SUSPICIOUS</span>
                  <span className="text-[10px] text-muted-foreground ml-auto">Anomalies found</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-red-400" />
                  <span className="text-xs font-mono text-red-400">COMPROMISED</span>
                  <span className="text-[10px] text-muted-foreground ml-auto">Active threats</span>
                </div>
              </div>
            </GlassDemo>
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            6. SCAN MODE CARDS
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="Scan Mode Grid" subtitle="19 scan modes across 4 categories — SDR/RF, Wireless, Security, Space">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3">
            {[
              { icon: Radio, label: "Pager", cat: "SDR/RF" },
              { icon: Waves, label: "433MHz", cat: "SDR/RF" },
              { icon: Thermometer, label: "Meters", cat: "SDR/RF" },
              { icon: Plane, label: "Aircraft", cat: "SDR/RF" },
              { icon: Ship, label: "Vessels", cat: "SDR/RF" },
              { icon: MapPin, label: "APRS", cat: "SDR/RF" },
              { icon: Volume2, label: "Listening Post", cat: "SDR/RF" },
              { icon: Terminal, label: "Spy Stations", cat: "SDR/RF" },
              { icon: Globe, label: "Meshtastic", cat: "SDR/RF" },
              { icon: Cpu, label: "Digital Voice", cat: "SDR/RF" },
              { icon: Antenna, label: "WebSDR", cat: "SDR/RF" },
              { icon: Wifi, label: "WiFi", cat: "Wireless" },
              { icon: Bluetooth, label: "Bluetooth", cat: "Wireless" },
              { icon: Shield, label: "TSCM", cat: "Security" },
              { icon: Satellite, label: "Satellite", cat: "Space" },
              { icon: Monitor, label: "ISS SSTV", cat: "Space" },
              { icon: Layers, label: "Weather Sat", cat: "Space" },
              { icon: Grid3x3, label: "HF SSTV", cat: "Space" },
            ].map((mode) => (
              <button
                key={mode.label}
                className="glass-card glass-panel-hover rounded-md p-4 flex flex-col items-center gap-2 text-center transition-all hover:scale-[1.02] group"
              >
                <mode.icon className="w-6 h-6 text-primary group-hover:text-foreground transition-colors" />
                <span className="text-xs font-mono text-foreground/80 group-hover:text-foreground transition-colors">{mode.label}</span>
                <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">{mode.cat}</span>
              </button>
            ))}
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            7. DEVICE TABLE
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="Device Table" subtitle="Discovered device inventory with signal strength, protocol, and status">
          <div className="glass-panel rounded-md overflow-hidden">
            <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono text-primary uppercase tracking-widest">Discovered Devices</span>
                <Badge className="bg-primary/10 text-primary border border-primary/20 font-mono text-[10px]">7 devices</Badge>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-7 text-[10px] font-mono">CSV</Button>
                <Button size="sm" variant="outline" className="h-7 text-[10px] font-mono">JSON</Button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border/30 text-muted-foreground">
                    <th className="text-left p-3 font-medium">IDENTIFIER</th>
                    <th className="text-left p-3 font-medium">PROTOCOL</th>
                    <th className="text-left p-3 font-medium">SIGNAL</th>
                    <th className="text-left p-3 font-medium">FREQUENCY</th>
                    <th className="text-left p-3 font-medium">LAST SEEN</th>
                    <th className="text-left p-3 font-medium">STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { id: "AA:BB:CC:DD:EE:01", proto: "WiFi", signal: -42, freq: "2.437 GHz", time: "2s ago", status: "active" },
                    { id: "ICAO: A4B2C8", proto: "ADS-B", signal: -68, freq: "1090 MHz", time: "5s ago", status: "active" },
                    { id: "MMSI: 211234567", proto: "AIS", signal: -71, freq: "162.025 MHz", time: "12s ago", status: "active" },
                    { id: "CAP: 0012345", proto: "POCSAG", signal: -55, freq: "462.5625 MHz", time: "1m ago", status: "idle" },
                    { id: "BLE: F8:A2:33:*", proto: "BLE", signal: -82, freq: "2.402 GHz", time: "3m ago", status: "idle" },
                    { id: "NOAA-19", proto: "APT", signal: -90, freq: "137.1 MHz", time: "8m ago", status: "lost" },
                    { id: "MESH: !a1b2c3d4", proto: "Meshtastic", signal: -63, freq: "906.875 MHz", time: "30s ago", status: "active" },
                  ].map((dev, i) => (
                    <tr key={i} className="border-b border-border/20 hover:bg-primary/5 transition-colors cursor-pointer group">
                      <td className="p-3 text-foreground group-hover:text-primary transition-colors">{dev.id}</td>
                      <td className="p-3">
                        <Badge variant="outline" className="text-[10px]">{dev.proto}</Badge>
                      </td>
                      <td className="p-3"><SignalBar value={Math.abs(dev.signal)} max={100} /></td>
                      <td className="p-3 text-muted-foreground">{dev.freq}</td>
                      <td className="p-3 text-muted-foreground">{dev.time}</td>
                      <td className="p-3">
                        {dev.status === "active" && (
                          <span className="flex items-center gap-1.5 text-emerald-400">
                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Active
                          </span>
                        )}
                        {dev.status === "idle" && (
                          <span className="flex items-center gap-1.5 text-amber-400">
                            <div className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Idle
                          </span>
                        )}
                        {dev.status === "lost" && (
                          <span className="flex items-center gap-1.5 text-red-400">
                            <div className="w-1.5 h-1.5 rounded-full bg-red-400" /> Lost
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            8. WATERFALL / SPECTRUM DISPLAY
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="Waterfall Display" subtitle="Real-time spectrum visualization — frequency vs time heatmap">
          <div className="glass-panel rounded-md overflow-hidden">
            <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs font-mono text-primary uppercase tracking-widest">RF Waterfall</span>
                <span className="text-[10px] font-mono text-muted-foreground">462.000 — 463.000 MHz</span>
              </div>
              <span className="text-[10px] font-mono text-muted-foreground">BW: 1.0 MHz | FFT: 1024</span>
            </div>
            <div className="p-4">
              <div className="rounded overflow-hidden border border-border/30">
                {Array.from({ length: 40 }, (_, i) => (
                  <WaterfallRow key={i} seed={i} />
                ))}
              </div>
              <div className="flex justify-between mt-2 text-[9px] font-mono text-muted-foreground">
                <span>462.000 MHz</span>
                <span>462.250</span>
                <span>462.500</span>
                <span>462.750</span>
                <span>463.000 MHz</span>
              </div>
            </div>
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            9. SIGNAL TIMELINE
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="Signal Timeline" subtitle="Decoded messages and events in chronological order">
          <div className="space-y-3">
            {[
              { time: "12:34:56", type: "POCSAG", msg: "ALPHA: FIRE DEPT RESPOND TO 123 MAIN ST — STRUCTURE FIRE", severity: "high", icon: AlertTriangle },
              { time: "12:34:42", type: "ADS-B", msg: "UAL1234 ALT:35000 SPD:480 HDG:270 — SQUAWK:1200", severity: "normal", icon: Plane },
              { time: "12:34:38", type: "WiFi", msg: "New AP: NETGEAR-5G (WPA2) Ch:36 RSSI:-52 — 3 clients", severity: "normal", icon: Wifi },
              { time: "12:34:21", type: "BLE", msg: "Apple AirTag detected — UUID: F8A233... RSSI:-78 Moving", severity: "info", icon: Bluetooth },
              { time: "12:34:15", type: "TSCM", msg: "RF ANOMALY: Unknown transmitter at 1.842 GHz — Power: -28dBm", severity: "critical", icon: Shield },
            ].map((evt, i) => (
              <div key={i} className={`glass-card rounded-md p-4 flex items-start gap-4 border-l-2 transition-all hover:scale-[1.005] ${
                evt.severity === "critical" ? "border-l-red-400" :
                evt.severity === "high" ? "border-l-amber-400" :
                evt.severity === "info" ? "border-l-sky-400" :
                "border-l-primary"
              }`}>
                <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${
                  evt.severity === "critical" ? "bg-red-500/20 text-red-400" :
                  evt.severity === "high" ? "bg-amber-500/20 text-amber-400" :
                  evt.severity === "info" ? "bg-sky-500/20 text-sky-400" :
                  "bg-primary/20 text-primary"
                }`}>
                  <evt.icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-mono text-muted-foreground">{evt.time}</span>
                    <Badge variant="outline" className="text-[9px] font-mono">{evt.type}</Badge>
                  </div>
                  <p className="text-sm font-mono text-foreground/90 truncate">{evt.msg}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            10. NAVIGATION RAIL PREVIEW
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="Navigation Rail" subtitle="64px icon rail — primary navigation for all platform sections">
          <div className="flex gap-6 items-start">
            <div className="glass-panel rounded-md p-2 w-16 flex flex-col items-center gap-1 shrink-0">
              {[
                { icon: Radar, label: "Scan", active: true },
                { icon: Eye, label: "Live", active: false },
                { icon: Cpu, label: "Devices", active: false },
                { icon: Signal, label: "Signals", active: false },
                { icon: Clock, label: "History", active: false },
                { icon: Settings, label: "Settings", active: false },
              ].map((item) => (
                <Tooltip key={item.label}>
                  <TooltipTrigger asChild>
                    <button className={`w-12 h-12 rounded-md flex flex-col items-center justify-center gap-0.5 transition-all ${
                      item.active
                        ? "bg-primary/15 text-primary border border-primary/20"
                        : "text-muted-foreground hover:text-foreground hover:bg-primary/5"
                    }`}>
                      <item.icon className="w-4 h-4" />
                      <span className="text-[8px] font-mono">{item.label}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right"><span className="font-mono text-xs">{item.label}</span></TooltipContent>
                </Tooltip>
              ))}
            </div>
            <div className="glass-card rounded-md p-6 flex-1">
              <p className="text-sm text-muted-foreground">
                The navigation rail sits at 64px width on the left edge. Each icon provides tooltip labels on hover.
                The active state uses a subtle <code className="text-primary">primary/15</code> background with a
                <code className="text-primary">primary/20</code> border. The rail collapses to icons-only on smaller
                viewports and can expand to 220px with labels on hover for ultrawide monitors.
              </p>
            </div>
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            11. TABS COMPONENT
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="Tabs & Accordion" subtitle="Content organization patterns used across scan modes and settings">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <GlassDemo label="Tabs">
              <Tabs defaultValue="sdr" className="w-full">
                <TabsList className="w-full">
                  <TabsTrigger value="sdr" className="flex-1 font-mono text-xs">SDR / RF</TabsTrigger>
                  <TabsTrigger value="wireless" className="flex-1 font-mono text-xs">Wireless</TabsTrigger>
                  <TabsTrigger value="security" className="flex-1 font-mono text-xs">Security</TabsTrigger>
                  <TabsTrigger value="space" className="flex-1 font-mono text-xs">Space</TabsTrigger>
                </TabsList>
                <TabsContent value="sdr" className="mt-3">
                  <p className="text-xs text-muted-foreground font-mono">Pager, 433MHz, Meters, Aircraft, Vessels, APRS, Listening Post, Spy Stations, Meshtastic, Digital Voice, WebSDR</p>
                </TabsContent>
                <TabsContent value="wireless" className="mt-3">
                  <p className="text-xs text-muted-foreground font-mono">WiFi Scanner, Bluetooth/BLE Scanner</p>
                </TabsContent>
                <TabsContent value="security" className="mt-3">
                  <p className="text-xs text-muted-foreground font-mono">TSCM Sweep — Counter-surveillance detection</p>
                </TabsContent>
                <TabsContent value="space" className="mt-3">
                  <p className="text-xs text-muted-foreground font-mono">Satellite Tracking, ISS SSTV, Weather Satellite, HF SSTV</p>
                </TabsContent>
              </Tabs>
            </GlassDemo>
            <GlassDemo label="Accordion (Sidebar Sections)">
              <Accordion type="multiple" defaultValue={["freq", "proto"]} className="w-full">
                <AccordionItem value="freq" className="border-border/30">
                  <AccordionTrigger className="text-xs font-mono uppercase tracking-widest text-foreground/80 py-2">Frequency</AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-2 text-xs font-mono text-muted-foreground">
                      <p>Range: 24 — 1766 MHz</p>
                      <p>Center: 462.5625 MHz</p>
                      <p>Bandwidth: 12.5 kHz</p>
                    </div>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="proto" className="border-border/30">
                  <AccordionTrigger className="text-xs font-mono uppercase tracking-widest text-foreground/80 py-2">Protocols</AccordionTrigger>
                  <AccordionContent>
                    <div className="flex flex-wrap gap-1.5">
                      {["POCSAG", "FLEX", "ACARS", "ADS-B", "AIS"].map(p => (
                        <Badge key={p} variant="outline" className="text-[9px] font-mono">{p}</Badge>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="settings" className="border-border/30">
                  <AccordionTrigger className="text-xs font-mono uppercase tracking-widest text-foreground/80 py-2">Settings</AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono text-muted-foreground">Gain</span>
                        <span className="text-xs font-mono text-foreground">Auto</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono text-muted-foreground">Sample Rate</span>
                        <span className="text-xs font-mono text-foreground">2.4 MSPS</span>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </GlassDemo>
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            12. PROGRESS & LOADING
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="Progress & Loading States" subtitle="Scan progress, signal strength meters, and loading animations">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <GlassDemo label="Scan Progress">
              <div className="space-y-4">
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-[10px] font-mono text-muted-foreground">WiFi Deep Scan</span>
                    <span className="text-[10px] font-mono text-primary">67%</span>
                  </div>
                  <Progress value={67} className="h-1.5" />
                </div>
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-[10px] font-mono text-muted-foreground">TSCM Sweep</span>
                    <span className="text-[10px] font-mono text-primary">100%</span>
                  </div>
                  <Progress value={100} className="h-1.5" />
                </div>
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-[10px] font-mono text-muted-foreground">Satellite Pass</span>
                    <span className="text-[10px] font-mono text-primary">23%</span>
                  </div>
                  <Progress value={23} className="h-1.5" />
                </div>
              </div>
            </GlassDemo>
            <GlassDemo label="Pulse Animations">
              <div className="flex items-center gap-6 justify-center py-4">
                <div className="flex flex-col items-center gap-2">
                  <div className="w-4 h-4 rounded-full bg-emerald-400 pulse-live" />
                  <span className="text-[9px] font-mono text-muted-foreground">LIVE</span>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className="w-10 h-10 rounded-full border-2 border-primary/40 flex items-center justify-center scan-pulse">
                    <Radar className="w-5 h-5 text-primary" />
                  </div>
                  <span className="text-[9px] font-mono text-muted-foreground">SCANNING</span>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className="w-16 h-3 rounded shimmer" />
                  <span className="text-[9px] font-mono text-muted-foreground">LOADING</span>
                </div>
              </div>
            </GlassDemo>
            <GlassDemo label="Signal Strength Bars">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-muted-foreground w-24">Excellent</span>
                  <SignalBar value={92} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-muted-foreground w-24">Good</span>
                  <SignalBar value={68} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-muted-foreground w-24">Fair</span>
                  <SignalBar value={45} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-muted-foreground w-24">Weak</span>
                  <SignalBar value={18} />
                </div>
              </div>
            </GlassDemo>
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            13. HERO IMAGE GALLERY
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="Generated Assets" subtitle="AI-generated hero images used across the platform">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {[
              { src: HERO_IMAGE, label: "RF Spectrum Visualization" },
              { src: SIGNAL_IMAGE, label: "Signal Wave Analysis" },
              { src: NETWORK_IMAGE, label: "Network Topology" },
              { src: SCAN_BG, label: "Scan Mode Background" },
            ].map((img) => (
              <div key={img.label} className="glass-card rounded-md overflow-hidden group">
                <div className="aspect-video overflow-hidden">
                  <img src={img.src} alt={img.label} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                </div>
                <div className="p-3">
                  <span className="text-[10px] font-mono text-muted-foreground">{img.label}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            14. CSS UTILITIES SHOWCASE
        ═══════════════════════════════════════════════════════════════ */}
        <Section title="CSS Utilities" subtitle="Custom utility classes available in the design system">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <GlassDemo label=".glow-text">
              <p className="text-xl font-display font-bold glow-text text-foreground">Glowing Header Text</p>
            </GlassDemo>
            <GlassDemo label=".glass-divider">
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">Content above</p>
                <div className="glass-divider" />
                <p className="text-xs text-muted-foreground">Content below</p>
              </div>
            </GlassDemo>
            <GlassDemo label=".data-flash">
              <div className="data-flash rounded p-2">
                <p className="text-xs font-mono text-foreground">This row just received new data</p>
              </div>
            </GlassDemo>
          </div>
        </Section>

        {/* ═══════════════════════════════════════════════════════════════
            FOOTER
        ═══════════════════════════════════════════════════════════════ */}
        <div className="glass-divider mt-16 mb-8" />
        <div className="text-center pb-8">
          <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-muted-foreground">
            Valentine RF // Obsidian Prism Theme Preview // Around Me — RF Reconnaissance Platform
          </p>
          <p className="text-[9px] font-mono text-muted-foreground/50 mt-2">
            Space Grotesk + IBM Plex Mono | oklch color space | glassmorphic surfaces | dark-first
          </p>
        </div>
      </div>
    </div>
  );
}
