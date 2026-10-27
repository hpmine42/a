/**
 * Handing the finished PDF to the phone.
 *
 * On a phone a "download" is a file in a folder nobody opens; the share sheet is
 * how a document actually leaves the app (mail, chat, Drive, print). Both paths
 * are offered when the browser supports sharing files, and the download is
 * always there as the answer that works everywhere.
 */

export type ShareOutcome = "shared" | "dismissed" | "unsupported" | "failed";

export function canSharePdf(blob: Blob, filename: string): boolean {
  try {
    const nav = navigator as Navigator & {
      canShare?: (data?: ShareData) => boolean;
      share?: (data?: ShareData) => Promise<void>;
    };
    if (typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
    if (typeof File !== "function") return false;
    const file = new File([blob], filename, { type: "application/pdf" });
    return nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** Is a file share sheet available at all (before a file exists)? */
export function sharingSupported(): boolean {
  try {
    const nav = navigator as Navigator & {
      canShare?: (data?: ShareData) => boolean;
      share?: (data?: ShareData) => Promise<void>;
    };
    if (typeof nav.share !== "function" || typeof File !== "function") return false;
    // Chrome only reveals canShare on secure origins; treat its absence as "no"
    if (typeof nav.canShare !== "function") return false;
    const probe = new File([new Blob(["x"])], "probe.pdf", { type: "application/pdf" });
    return nav.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export async function sharePdf(blob: Blob, filename: string): Promise<ShareOutcome> {
  try {
    if (!canSharePdf(blob, filename)) return "unsupported";
    const file = new File([blob], filename, { type: "application/pdf" });
    await navigator.share({
      files: [file],
      title: filename.replace(/\.pdf$/i, ""),
    });
    return "shared";
  } catch (err) {
    // Cancelling the sheet is not an error the user should see.
    if ((err as DOMException)?.name === "AbortError") return "dismissed";
    return "failed";
  }
}
