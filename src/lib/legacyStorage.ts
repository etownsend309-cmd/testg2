/**
 * Clean-up for agreement records the app used to keep in browser storage.
 *
 * Before the screens moved onto the API, every agreement, its extracted text
 * and its review were saved in `localStorage` under this key. Nothing reads
 * that copy any more, but it would otherwise sit in each browser that used the
 * old version, holding contract text indefinitely. It is removed, not
 * migrated: these were prototype records, and the server is now the only
 * place agreements live.
 */

export const LEGACY_AGREEMENTS_KEY = "clausepilot-agreements-v1";

/** Removes the old local agreement records. Returns true if there were any. Never throws. */
export function clearLegacyAgreements(storage: Pick<Storage, "getItem" | "removeItem"> | undefined = defaultStorage()): boolean {
  try {
    if (!storage || storage.getItem(LEGACY_AGREEMENTS_KEY) === null) return false;
    storage.removeItem(LEGACY_AGREEMENTS_KEY);
    return true;
  } catch {
    // Storage can be blocked entirely (privacy settings, sandboxed frames);
    // then there is nothing this page could have stored either.
    return false;
  }
}

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
