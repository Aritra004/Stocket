"use client";

export function SkipToContent() {
  return (
    <a
      href="#main-content"
      className="sr-only fixed top-3 left-3 z-50 rounded-lg bg-white p-3 text-sm shadow-lg focus:not-sr-only"
      onClick={(event) => {
        const main = document.getElementById("main-content");
        if (!main) return;
        // History selections use the fragment. Move focus without replacing
        // the selected supplier, SKU, or purchase-order record in the URL.
        event.preventDefault();
        main.focus({ preventScroll: true });
        main.scrollIntoView({ block: "start" });
      }}
    >
      Skip to main content
    </a>
  );
}
