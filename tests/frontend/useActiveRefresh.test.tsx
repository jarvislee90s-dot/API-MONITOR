import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useActiveRefresh } from "../../frontend/src/hooks/useActiveRefresh";

describe("useActiveRefresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("会在活跃时按间隔刷新并在空闲后停止", () => {
    vi.useFakeTimers();

    const refresh = vi.fn();
    const { result } = renderHook(() =>
      useActiveRefresh(refresh, { intervalMs: 120000, idleMs: 600000 }),
    );

    expect(result.current.isActive).toBe(true);

    act(() => {
      vi.advanceTimersByTime(120000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("pointerdown"));
      vi.advanceTimersByTime(480000);
    });

    expect(result.current.isActive).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(5);

    act(() => {
      vi.advanceTimersByTime(120000);
    });

    expect(result.current.isActive).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(5);
  });
});
