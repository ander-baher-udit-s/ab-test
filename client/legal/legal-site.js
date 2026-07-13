(function () {
  var params = new URLSearchParams(window.location.search);
  var changedVersion = params.get("changedVersion");
  var shouldShowChanged = params.get("showChanged") === "true" && !!changedVersion;
  var dismissKey = changedVersion ? "legalChangeDismissed:" + changedVersion : "";

  preserveQueryParamsOnTabs(params);

  if (!shouldShowChanged || !dismissKey) {
    return;
  }

  if (window.sessionStorage.getItem(dismissKey) === "true") {
    return;
  }

  fetch("./legal-updates.json", { cache: "no-store" })
    .then(function (response) {
      if (!response.ok) {
        throw new Error("Unable to load legal update summary.");
      }

      return response.json();
    })
    .then(function (updates) {
      var update = updates[changedVersion];
      if (!update) {
        return;
      }

      renderChangedModal(changedVersion, update, dismissKey);
    })
    .catch(function () {
      return;
    });

  function preserveQueryParamsOnTabs(searchParams) {
    var tabLinks = document.querySelectorAll(".tab-nav a");
    if (!tabLinks.length || !searchParams.toString()) {
      return;
    }

    tabLinks.forEach(function (link) {
      var targetUrl = new URL(link.getAttribute("href"), window.location.href);
      searchParams.forEach(function (value, key) {
        targetUrl.searchParams.set(key, value);
      });
      link.setAttribute("href", targetUrl.pathname + targetUrl.search);
    });
  }

  function renderChangedModal(version, update, storageKey) {
    var backdrop = document.createElement("div");
    backdrop.className = "legal-modal-backdrop";
    backdrop.setAttribute("role", "presentation");

    var dialog = document.createElement("section");
    dialog.className = "legal-modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "legal-whats-changed-title");
    dialog.setAttribute("aria-describedby", "legal-whats-changed-body");
    dialog.tabIndex = -1;

    var headingId = "legal-whats-changed-title";
    var descriptionId = "legal-whats-changed-body";
    var effectiveDate = update.effectiveDate || "";
    var scopeLabel = formatScope(update.documentsChanged || []);
    var summaryItems = Array.isArray(update.summary) ? update.summary : [];

    dialog.innerHTML =
      '<div class="legal-modal-badge">Review policy updates</div>' +
      '<h2 id="' + headingId + '">What&apos;s Changed</h2>' +
      '<p class="legal-modal-lead" id="' + descriptionId + '">Quickly review the latest changes made to the Terms &amp; Conditions and Privacy Policy.</p>' +
      '<div class="legal-modal-meta">' +
      '<div><span class="legal-modal-meta-label">Version</span><span class="legal-modal-meta-value">' +
      escapeHtml(version) +
      "</span></div>" +
      '<div><span class="legal-modal-meta-label">Effective Date</span><span class="legal-modal-meta-value">' +
      escapeHtml(effectiveDate) +
      "</span></div>" +
      '<div><span class="legal-modal-meta-label">Updated</span><span class="legal-modal-meta-value">' +
      escapeHtml(scopeLabel) +
      "</span></div>" +
      "</div>" +
      '<div class="legal-modal-summary"><h3>Summary of updates</h3><ul>' +
      summaryItems.map(function (item) {
        return "<li>" + escapeHtml(item) + "</li>";
      }).join("") +
      "</ul></div>" +
      '<div class="legal-modal-actions">' +
      '<button class="legal-modal-action" type="button">Close</button>' +
      "</div>";

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    document.body.classList.add("legal-modal-open");
    dialog.focus();

    var actionButton = dialog.querySelector(".legal-modal-action");

    function cleanup() {
      document.body.classList.remove("legal-modal-open");
      document.removeEventListener("keydown", onKeydown);
      backdrop.remove();
    }

    function closeDialog() {
      window.sessionStorage.setItem(storageKey, "true");
      cleanup();
    }

    function onKeydown(event) {
      if (event.key === "Escape") {
        closeDialog();
      }
    }

    actionButton.addEventListener("click", closeDialog);
    backdrop.addEventListener("click", function (event) {
      if (event.target === backdrop) {
        closeDialog();
      }
    });
    document.addEventListener("keydown", onKeydown);
  }

  function formatScope(documentsChanged) {
    var labels = documentsChanged
      .map(function (document) {
        if (document === "terms") {
          return "Terms & Conditions";
        }
        if (document === "privacy") {
          return "Privacy Policy";
        }
        return document;
      })
      .filter(Boolean);

    return labels.length ? labels.join(" and ") : "Legal documents";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
