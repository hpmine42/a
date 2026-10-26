import { describe, expect, it, vi } from "vitest";
import {
  installedRelatedApps,
  isStaleInstall,
  isStandaloneDisplay,
  promptInstall,
  shouldOfferInstall,
  watchInstallPrompt,
} from "../src/lib/install";

describe("standalone detection", () => {
  it("accepts both the matchMedia flag and the iOS property", () => {
    expect(isStandaloneDisplay(true)).toBe(true);
    expect(isStandaloneDisplay(false, true)).toBe(true);
    expect(isStandaloneDisplay(false, false)).toBe(false);
    expect(isStandaloneDisplay(false)).toBe(false);
  });
});

describe("install invitation", () => {
  it("is only offered when the browser has a prompt and we are a tab", () => {
    expect(shouldOfferInstall({ promptReady: true, standalone: false })).toBe(true);
    expect(shouldOfferInstall({ promptReady: true, standalone: true })).toBe(false);
    expect(shouldOfferInstall({ promptReady: false, standalone: false })).toBe(false);
  });
});

describe("stale install detection", () => {
  it("is never reported from inside the installed app", () => {
    expect(isStaleInstall([{ platform: "webapp" }], true)).toBe(false);
  });

  it("is reported when a related app exists but we are in a tab", () => {
    expect(isStaleInstall([{ platform: "webapp", id: "https://example.test/" }], false)).toBe(true);
  });

  it("treats a missing or empty answer as nothing installed", () => {
    expect(isStaleInstall([], false)).toBe(false);
    expect(isStaleInstall(undefined, false)).toBe(false);
    expect(isStaleInstall(null, false)).toBe(false);
  });
});

describe("installedRelatedApps", () => {
  it("returns an empty list where the API does not exist", async () => {
    expect(await installedRelatedApps({})).toEqual([]);
    expect(await installedRelatedApps(undefined)).toEqual([]);
  });

  it("passes the answer through, and swallows a rejection", async () => {
    const ok = { getInstalledRelatedApps: async () => [{ platform: "webapp" }] };
    expect(await installedRelatedApps(ok)).toHaveLength(1);

    const boom = {
      getInstalledRelatedApps: async () => {
        throw new Error("nope");
      },
    };
    expect(await installedRelatedApps(boom)).toEqual([]);
  });
});

describe("install prompt", () => {
  it("captures the event, blocks the mini banner and replays it once", async () => {
    const onAvailable = vi.fn();
    const onInstalled = vi.fn();
    const stop = watchInstallPrompt({ onAvailable, onInstalled });

    const prompt = vi.fn(async () => undefined);
    const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: "accepted" }>;
    };
    Object.defineProperty(event, "prompt", { value: prompt });
    Object.defineProperty(event, "userChoice", { value: Promise.resolve({ outcome: "accepted" }) });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onAvailable).toHaveBeenCalled();

    expect(await promptInstall()).toBe("accepted");
    expect(prompt).toHaveBeenCalledTimes(1);
    // the captured event is single-use
    expect(await promptInstall()).toBe("unavailable");

    window.dispatchEvent(new Event("appinstalled"));
    expect(onInstalled).toHaveBeenCalled();
    stop();
  });

  it("reports a dismissed prompt", async () => {
    const stop = watchInstallPrompt({ onAvailable: () => undefined, onInstalled: () => undefined });
    const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: "dismissed" }>;
    };
    Object.defineProperty(event, "prompt", { value: async () => undefined });
    Object.defineProperty(event, "userChoice", { value: Promise.resolve({ outcome: "dismissed" }) });
    window.dispatchEvent(event);

    expect(await promptInstall()).toBe("dismissed");
    stop();
  });
});
