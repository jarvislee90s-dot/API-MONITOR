import { useCallback, useEffect, useRef, useState } from "react";

export interface UseActiveRefreshOptions {
  intervalMs?: number;
  idleMs?: number;
  enabled?: boolean;
}

export interface UseActiveRefreshState {
  isActive: boolean;
  lastActivityAt: number | null;
  lastRefreshAt: number | null;
  markActive: () => void;
  refreshNow: () => void;
}

export function useActiveRefresh(
  refresh: () => void | Promise<void>,
  options: UseActiveRefreshOptions = {},
): UseActiveRefreshState {
  const {
    intervalMs = 120_000,
    idleMs = 600_000,
    enabled = true,
  } = options;

  const refreshRef = useRef(refresh);
  const intervalMsRef = useRef(intervalMs);
  const idleMsRef = useRef(idleMs);
  const activeRef = useRef(enabled);
  const lastActivityAtRef = useRef<number | null>(null);
  const lastRefreshAtRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const intervalTimerRef = useRef<number | null>(null);

  const [isActive, setIsActive] = useState(enabled);
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);

  refreshRef.current = refresh;
  intervalMsRef.current = intervalMs;
  idleMsRef.current = idleMs;
  activeRef.current = isActive;

  const stopInterval = useCallback(() => {
    if (intervalTimerRef.current !== null) {
      window.clearInterval(intervalTimerRef.current);
      intervalTimerRef.current = null;
    }
  }, []);

  const stopIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const runRefresh = useCallback(() => {
    const now = Date.now();
    lastRefreshAtRef.current = now;
    setLastRefreshAt(now);
    return Promise.resolve(refreshRef.current()).catch(() => undefined);
  }, []);

  const startInterval = useCallback(() => {
    stopInterval();

    if (!enabled) {
      return;
    }

    intervalTimerRef.current = window.setInterval(() => {
      if (!activeRef.current) {
        return;
      }

      const lastActivity = lastActivityAtRef.current ?? Date.now();
      if (Date.now() - lastActivity >= idleMsRef.current) {
        setIsActive(false);
        stopInterval();
        return;
      }

      void runRefresh();
    }, intervalMsRef.current);
  }, [enabled, runRefresh, stopInterval]);

  const scheduleIdleStop = useCallback(() => {
    stopIdleTimer();

    if (!enabled) {
      return;
    }

    idleTimerRef.current = window.setTimeout(() => {
      setIsActive(false);
      stopInterval();
    }, idleMsRef.current);
  }, [enabled, idleMs, stopIdleTimer, stopInterval]);

  const markActive = useCallback(() => {
    if (!enabled) {
      return;
    }

    const now = Date.now();
    const wasInactive = !activeRef.current;

    lastActivityAtRef.current = now;
    setLastActivityAt(now);
    setIsActive(true);
    scheduleIdleStop();

    if (wasInactive) {
      startInterval();
      void runRefresh();
    }
  }, [enabled, runRefresh, scheduleIdleStop, startInterval]);

  useEffect(() => {
    if (!enabled) {
      setIsActive(false);
      return;
    }

    const handleActivity = () => {
      markActive();
    };

    const activityEvents: Array<keyof WindowEventMap> = [
      "pointerdown",
      "keydown",
      "scroll",
      "mousemove",
      "touchstart",
      "focus",
    ];

    activityEvents.forEach((eventName) => {
      window.addEventListener(eventName, handleActivity, { passive: true });
    });

    const visibilityHandler = () => {
      if (!document.hidden) {
        markActive();
      }
    };

    document.addEventListener("visibilitychange", visibilityHandler);

    lastActivityAtRef.current = Date.now();
    setLastActivityAt(lastActivityAtRef.current);
    setIsActive(true);
    scheduleIdleStop();
    startInterval();

    return () => {
      activityEvents.forEach((eventName) => {
        window.removeEventListener(eventName, handleActivity);
      });
      document.removeEventListener("visibilitychange", visibilityHandler);
      stopIdleTimer();
      stopInterval();
    };
  }, [enabled, markActive, scheduleIdleStop, startInterval, stopIdleTimer, stopInterval]);

  return {
    isActive,
    lastActivityAt,
    lastRefreshAt,
    markActive,
    refreshNow: () => {
      void runRefresh();
    },
  };
}
