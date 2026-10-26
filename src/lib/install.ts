/* Installability, and the one failure mode that looks like a bug in the app:
 *
 * a home-screen entry can exist while the app behind it does not work. Renaming
 * a GitHub repository moves a project site from /old/ to /new/ and GitHub does
 * not redirect it, so an app installed before the rename keeps a start_url that
 * now 404s. Android shows "already installed" (the entry exists) and "could not
 * be opened" (the URL is gone). Nothing on the page can repair that entry — but
 * we can say so, with the two taps that fix it.
 *
 * `getInstalledRelatedApps()` only answers for apps the manifest declares under
 * related_applications, which is why that block exists.
 */

type RelatedApp = { platform?: string; id?: string; url?: string; version?: string };

export type InstallState = {
  /** Chrome delivered a beforeinstallprompt event we can replay on a tap. */
  promptReady: boolean;
  /** We are running as the installed app, not in a browser tab. */
  standalone: boolean;
  /** A home-screen entry exists while this tab is the browser: likely broken. */
  staleInstall: boolean;
};

export function isStandaloneDisplay(matches: boolean, iOSStandalone?: boolean): boolean {
  return matches || iOSStandalone === true;
}

/**
 * Should the camera offer an "Install" control? Not when we already are the
 * installed app, and not when Chrome has no prompt to give us.
 */
export function shouldOfferInstall(state: Pick<InstallState, "promptReady" | "standalone">): boolean {
  return state.promptReady && !state.standalone;
}

/**
 * A related app counts as a stale install only if this page is *not* running
 * standalone — otherwise it is simply us.
 */
export function isStaleInstall(apps: RelatedApp[] | undefined | null, standalone: boolean): boolean {
  if (standalone) return false;
  return Array.isArray(apps) && apps.length > 0;
}

/** The shape we need; the API is not in every TypeScript lib version yet. */
export type RelatedAppsApi = { getInstalledRelatedApps?: () => Promise<unknown> };

/** Ask the browser which related apps are installed; never throws. */
export async function installedRelatedApps(
  nav: RelatedAppsApi | undefined = typeof navigator === "undefined" ? undefined : (navigator as RelatedAppsApi)
): Promise<RelatedApp[]> {
  if (!nav || typeof nav.getInstalledRelatedApps !== "function") return [];
  try {
    const apps = await nav.getInstalledRelatedApps();
    return Array.isArray(apps) ? (apps as RelatedApp[]) : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------- prompt glue */

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: InstallPromptEvent | null = null;

/**
 * Listen once, from the app root. `preventDefault` keeps Chrome's own mini
 * banner away so the only invitation is ours.
 */
export function watchInstallPrompt(handlers: {
  onAvailable: () => void;
  onInstalled: () => void;
}): () => void {
  const onPrompt = (event: Event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    handlers.onAvailable();
  };
  const onInstalled = () => {
    deferred = null;
    handlers.onInstalled();
  };
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  return () => {
    window.removeEventListener("beforeinstallprompt", onPrompt);
    window.removeEventListener("appinstalled", onInstalled);
  };
}

/** Replay the captured prompt. Returns what the user chose. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferred) return "unavailable";
  const event = deferred;
  deferred = null;
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice?.outcome === "accepted" ? "accepted" : "dismissed";
  } catch {
    return "unavailable";
  }
}
