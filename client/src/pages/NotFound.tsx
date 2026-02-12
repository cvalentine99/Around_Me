import { Button } from "@/components/ui/button";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { useLocation } from "wouter";

export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen w-full flex items-center justify-center">
      <div className="glass-panel rounded-lg p-8 max-w-md mx-4 text-center">
        <div className="flex justify-center mb-6">
          <div className="relative">
            <div className="absolute inset-0 rounded-full scan-pulse" />
            <AlertCircle className="relative h-12 w-12 text-destructive" />
          </div>
        </div>

        <h1 className="text-4xl font-display font-bold text-foreground mb-2 glow-text">404</h1>

        <h2 className="text-lg font-display font-semibold text-muted-foreground mb-4">
          Signal Not Found
        </h2>

        <p className="text-sm font-mono text-muted-foreground mb-8 leading-relaxed">
          The requested frequency is not in our scan range.
          <br />
          It may have been decommissioned.
        </p>

        <Button
          onClick={() => setLocation("/scan")}
          className="gap-2 font-mono text-xs tracking-wider"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          RETURN TO SCAN
        </Button>
      </div>
    </div>
  );
}
