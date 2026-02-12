import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import AppShell from "./components/AppShell";
import ScanPage from "./pages/Scan";
import LiveViewPage from "./pages/LiveView";
import DevicesPage from "./pages/Devices";
import SignalsPage from "./pages/Signals";
import HistoryPage from "./pages/History";
import SettingsPage from "./pages/Settings";
import ThemePreview from "./pages/ThemePreview";
import GeospatialPage from "./pages/Geospatial";

function Router() {
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={ScanPage} />
        <Route path="/scan" component={ScanPage} />
        <Route path="/live" component={LiveViewPage} />
        <Route path="/devices" component={DevicesPage} />
        <Route path="/signals" component={SignalsPage} />
        <Route path="/history" component={HistoryPage} />
        <Route path="/geo" component={GeospatialPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/preview" component={ThemePreview} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster
            theme="dark"
            toastOptions={{
              style: {
                background: 'oklch(0.14 0.025 285 / 0.8)',
                backdropFilter: 'blur(20px)',
                border: '1px solid oklch(0.65 0.18 285 / 0.2)',
                color: 'oklch(0.9 0.01 290)',
              },
            }}
          />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
