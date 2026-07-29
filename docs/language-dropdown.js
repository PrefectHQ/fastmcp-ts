// Language dropdown: a small Python/TypeScript switcher injected into the
// sidebar footer, next to Mintlify's theme selector. Selecting the other
// language navigates to that project's docs site; selecting the current
// language is a no-op. Styling lives in style.css. The Python docs carry the
// mirror-image control (docs/language-dropdown.js in PrefectHQ/fastmcp).
(function () {
  if (typeof window === "undefined") return;

  var CURRENT_LANGUAGE = "typescript";

  // The Python docs URL comes from that repo's pyproject.toml / README.
  var PYTHON_DOCS_URL = "https://gofastmcp.com";
  var TYPESCRIPT_DOCS_URL = "/";

  var URLS = { python: PYTHON_DOCS_URL, typescript: TYPESCRIPT_DOCS_URL };

  function findThemeSelector() {
    // Mintlify's sidebar-footer DOM is not a stable public API, so probe a
    // few markers (almond theme first) and give up quietly if none match.
    return (
      document.querySelector("[data-theme-preference-switch]") ||
      document.querySelector('[role="group"][aria-label="Theme preference"]')
    );
  }

  function buildDropdown() {
    var label = document.createElement("label");
    label.id = "language-switch";

    var select = document.createElement("select");
    select.setAttribute("aria-label", "Switch documentation language");

    [
      ["python", "Python"],
      ["typescript", "TypeScript"],
    ].forEach(function (entry) {
      var option = document.createElement("option");
      option.value = entry[0];
      option.textContent = entry[1];
      if (entry[0] === CURRENT_LANGUAGE) option.selected = true;
      select.appendChild(option);
    });

    select.addEventListener("change", function () {
      if (select.value === CURRENT_LANGUAGE) return;
      window.location.href = URLS[select.value];
    });

    label.appendChild(select);
    return label;
  }

  function addDropdown() {
    if (document.getElementById("language-switch")) return;
    var theme = findThemeSelector();
    if (!theme || !theme.parentElement) return;
    // Insert after the theme pill; margin-left:auto floats it right.
    theme.parentElement.insertBefore(buildDropdown(), theme.nextSibling);
  }

  function run() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", addDropdown);
    } else {
      addDropdown();
    }
  }

  run();

  // Mintlify re-renders the sidebar on client-side navigation; re-inject when
  // the dropdown disappears.
  new MutationObserver(function () {
    if (!document.getElementById("language-switch")) addDropdown();
  }).observe(document.body, { subtree: true, childList: true });
})();
