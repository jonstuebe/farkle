import { useEffect, useState } from "react";
import { fetchRoomSummary } from "../../net/api";
import type { RoomSummary } from "../../net/protocol";

/** `undefined`: still checking. `null`: couldn't reach the server. */
export type SummaryState = RoomSummary | null | undefined;

const REFRESH_MS = 20_000;

/**
 * Live status for the home-screen list: one `GET summary` per saved room, refreshed every
 * 20 seconds while the page is visible and whenever the player comes back to it.
 */
export function useRoomSummaries(codes: readonly string[], deviceId: string): ReadonlyMap<string, SummaryState> {
  const [summaries, setSummaries] = useState<ReadonlyMap<string, SummaryState>>(() => new Map());
  const key = codes.join(",");

  useEffect(() => {
    const list = key === "" ? [] : key.split(",");
    if (list.length === 0) return;
    const controller = new AbortController();

    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      for (const code of list) {
        void fetchRoomSummary(code, deviceId, { signal: controller.signal }).then((summary) => {
          if (controller.signal.aborted) return;
          setSummaries((current) => {
            // Keep the last good answer through a blip instead of flashing "couldn't check".
            if (summary === null && current.get(code)) return current;
            return new Map(current).set(code, summary);
          });
        });
      }
    };

    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [key, deviceId]);

  return summaries;
}
