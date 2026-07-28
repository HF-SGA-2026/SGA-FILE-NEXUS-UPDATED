(() => {
  "use strict";

  const frame = document.querySelector("#folderDiscarderWorkspace .folder-discarder-frame");
  if (!frame) return;

  window.addEventListener("message", (event) => {
    if (
      event.origin !== window.location.origin
      || event.source !== frame.contentWindow
      || event.data?.type !== "sga-folder-discarder-height"
    ) {
      return;
    }

    const height = Number(event.data.height);
    if (!Number.isFinite(height)) return;
    frame.style.height = `${Math.min(Math.max(Math.ceil(height), 800), 10000)}px`;
  });
})();
