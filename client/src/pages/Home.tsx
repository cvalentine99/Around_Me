/**
 * Home Page — Redirects to Scan page (the default view)
 * The Scan page is the primary entry point for the application.
 */
import { useEffect } from "react";
import { useLocation } from "wouter";

export default function Home() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    setLocation("/scan");
  }, [setLocation]);

  return null;
}
