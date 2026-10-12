import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root was not found in index.html.");

/**
 * A file dropped anywhere outside a drop zone makes the browser navigate to it
 * and open its own PDF viewer, which replaces the app and loses whatever the
 * reviewer was doing. Suppressing the default at the document level turns a
 * near-miss drop into a no-op. The drop zones still receive the drops that
 * land on them, because this listener runs after theirs on the way up.
 */
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (event) => event.preventDefault());
}

/**
 * The review app and the extraction harness are mutually exclusive views, and
 * each owns a global stylesheet. The two sheets both style `body`, `button`,
 * `.panel`, and `.eyebrow`, so loading both would let one win arbitrarily.
 * Importing a view and its stylesheet together, on demand, keeps them isolated
 * without rewriting either sheet to be scoped.
 */
async function loadView(): Promise<ComponentType> {
  const wantsHarness =
    new URLSearchParams(window.location.search).get("view") === "extraction-poc";

  if (wantsHarness) {
    await import("./poc/styles.css");
    return (await import("./poc/PocApp")).default;
  }

  await import("./styles.css");
  const { AuthGate } = await import("./components/AuthGate");
  const App = (await import("./App")).default;

  return function GatedApp() {
    return (
      <AuthGate>
        {(user, signOut) => <App user={user} onSignOut={signOut} />}
      </AuthGate>
    );
  };
}

loadView().then((View) => {
  createRoot(container).render(
    <StrictMode>
      <View />
    </StrictMode>,
  );
});
