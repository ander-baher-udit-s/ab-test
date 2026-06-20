(function () {
  const ABChatbot = {};

  const DEFAULT_WELCOME_TEXT =
    "Hello. I can help with punch issues, location, face verification, OTP, regularisation, and subscription/payment questions.";

  const READY_TEXT =
    "I am now ready to guide you with your questions.";

  ABChatbot.mount = function (selectorOrElement, options) {
    const root =
      typeof selectorOrElement === "string"
        ? document.querySelector(selectorOrElement)
        : selectorOrElement;

    if (!root) {
      throw new Error("ABChatbot root element not found.");
    }

    const cfg = normalizeConfig_(root, options || {});

    const state = {
      gasUrl: cfg.gasUrl,
      token: cfg.token || "",
      orgId: cfg.orgId,
      userId: cfg.userId,
      userName: cfg.userName,
      userEmail: cfg.userEmail,
      contexts: cfg.contexts,
      history: [],
      selectedChunks: [],

      /*
        Single latest image upload only.
        Cleared when chat is cleared.
        Sent to Jira only when Raise Ticket is clicked.
      */
      uploadedImage: null,
      uploadedImageMessageEl: null,

      lastMatches: [],
      isAsking: false,
      isUploading: false,
      suggestionsCollapsed: false,
      hasShownReadyMessage: false
    };

    renderShell_(root, cfg);
    bindEvents_(root, state);
    init_(root, state);
  };

  async function init_(root, state) {
    if (state.token) {
      showReadyMessageOnce_(root, state);
      return;
    }

    addBotMessage_(
      root,
      "Chat session could not be initialized. Missing bootstrap token.",
      true
    );
  }

  function renderShell_(root, cfg) {
    root.innerHTML = `
      <div class="ab-chat-widget">
        <div class="ab-chat-header">
          <div class="ab-chat-title">${escapeHtml_(cfg.title || "Support Assistant")}</div>

          <div class="ab-chat-actions">
            <button class="ab-chat-clear" type="button" data-ab-clear aria-label="Clear chat">
              Clear
            </button>
            <button class="ab-chat-close" type="button" data-ab-close aria-label="Close support assistant">
              ×
            </button>
          </div>
        </div>

        <div class="ab-chat-context">
          <div class="ab-chat-context-line">
            Chatbot loaded for ${escapeHtml_(cfg.userName || cfg.userEmail || "user")}
          </div>
          ${
            cfg.orgId
              ? `<div class="ab-chat-context-line">
                  Organization: ${escapeHtml_(cfg.orgId)}
                </div>`
              : ""
          }
        </div>

        <div class="ab-suggestions-panel" data-ab-suggestions-panel>
          <button class="ab-suggestions-toggle" type="button" data-ab-toggle-suggestions>
            <span>Suggested questions</span>
            <span data-ab-suggestions-icon>⌃</span>
          </button>

          <div class="ab-suggested-row" data-ab-suggestions>
            ${renderSuggestionChips_(cfg.suggestions)}
          </div>
        </div>

        <div class="ab-chat-body" data-ab-body>
          ${renderDefaultBanner_()}
        </div>

        <div class="ab-chat-footer">
          <div class="ab-input-wrap">
            <button
              class="ab-upload-button"
              type="button"
              data-ab-upload
              aria-label="Upload image"
              title="Upload image"
            >
              +
            </button>

            <input
              class="ab-file-input"
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
              data-ab-file
            />

            <input
              class="ab-input"
              type="text"
              placeholder="${escapeHtml_(cfg.placeholder || "Ask a question...")}"
              data-ab-input
            />
          </div>

          <button class="ab-send-button" type="button" data-ab-send>
            ${escapeHtml_(cfg.sendLabel || "Send")}
          </button>
        </div>
      </div>
    `;
  }

  function renderDefaultBanner_() {
    return `
      <div class="ab-message-row bot" data-ab-default-banner>
        <div class="ab-bubble">
          ${escapeHtml_(DEFAULT_WELCOME_TEXT)}
        </div>
      </div>
    `;
  }

  function renderSuggestionChips_(suggestions) {
    const list =
      Array.isArray(suggestions) && suggestions.length
        ? suggestions
        : [
            "Know more about the Ander Baher Attendance experience",
            "How to use the Ander Baher Attendance app?",
            "I cannot punch in",
            "It says I am outside location",
            "My face verification is failing",
            "I did not receive OTP",
            "How do I regularise attendance?",
            "Payment done but subscription not updated"
          ];

    return list
      .map(function (text) {
        return `
          <button class="ab-suggestion-chip" type="button" data-ab-suggestion="${escapeAttr_(text)}">
            ${escapeHtml_(text)}
          </button>
        `;
      })
      .join("");
  }

  function bindEvents_(root, state) {
    const input = root.querySelector("[data-ab-input]");
    const send = root.querySelector("[data-ab-send]");
    const upload = root.querySelector("[data-ab-upload]");
    const fileInput = root.querySelector("[data-ab-file]");

    send.addEventListener("click", function () {
      ask_(root, state);
    });

    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        ask_(root, state);
      }
    });

    if (upload && fileInput) {
      upload.addEventListener("click", function () {
        if (state.isUploading || state.isAsking) return;

        fileInput.value = "";
        fileInput.click();
      });

      fileInput.addEventListener("change", function () {
        const file = fileInput.files && fileInput.files[0];

        if (file) {
          uploadImage_(root, state, file);
        }
      });
    }

    root.querySelectorAll("[data-ab-suggestion]").forEach(function (button) {
      button.addEventListener("click", function () {
        input.value = button.getAttribute("data-ab-suggestion") || "";
        ask_(root, state);
      });
    });

    const toggleSuggestions = root.querySelector("[data-ab-toggle-suggestions]");
    const suggestionsPanel = root.querySelector("[data-ab-suggestions-panel]");
    const suggestionsIcon = root.querySelector("[data-ab-suggestions-icon]");

    if (toggleSuggestions && suggestionsPanel) {
      toggleSuggestions.addEventListener("click", function () {
        state.suggestionsCollapsed = !state.suggestionsCollapsed;

        suggestionsPanel.classList.toggle(
          "ab-suggestions-collapsed",
          state.suggestionsCollapsed
        );

        if (suggestionsIcon) {
          suggestionsIcon.textContent = state.suggestionsCollapsed ? "⌄" : "⌃";
        }
      });
    }

    const clear = root.querySelector("[data-ab-clear]");
    if (clear) {
      clear.addEventListener("click", function () {
        resetChat_(root, state);
      });
    }

    const close = root.querySelector("[data-ab-close]");
    if (close) {
      close.addEventListener("click", function () {
        try {
          window.parent.postMessage(
            {
              source: "AB_CHATBOT",
              type: "close"
            },
            "*"
          );
        } catch (err) {}

        /*
          Do not destroy the iframe or chatbot DOM.
          Parent loader should only hide the floating panel.
        */
      });
    }
  }

  function resetChat_(root, state) {
    const body = root.querySelector("[data-ab-body]");

    state.history = [];
    state.selectedChunks = [];

    clearUploadedImageState_(state);

    state.lastMatches = [];
    state.isAsking = false;
    state.isUploading = false;
    state.hasShownReadyMessage = false;

    body.innerHTML = renderDefaultBanner_();

    showReadyMessageOnce_(root, state);
    scrollBottom_(root);

    const input = root.querySelector("[data-ab-input]");
    const send = root.querySelector("[data-ab-send]");
    const upload = root.querySelector("[data-ab-upload]");

    if (input) {
      input.disabled = false;
      input.value = "";
      input.focus();
    }

    if (send) {
      send.disabled = false;
    }

    if (upload) {
      upload.disabled = false;
    }
  }

  function clearUploadedImageState_(state) {
    if (state.uploadedImage && state.uploadedImage.previewUrl) {
      try {
        URL.revokeObjectURL(state.uploadedImage.previewUrl);
      } catch (err) {}
    }

    state.uploadedImage = null;
    state.uploadedImageMessageEl = null;
  }

  function showReadyMessageOnce_(root, state) {
    if (state.hasShownReadyMessage) return;

    state.hasShownReadyMessage = true;

    addBotMessage_(root, READY_TEXT);
  }

  function addBotHtmlMessage_(root, html, isError) {
    const body = root.querySelector("[data-ab-body]");

    body.insertAdjacentHTML(
      "beforeend",
      `
      <div class="ab-message-row bot ${isError ? "error" : ""}">
        <div class="ab-bubble">${html}</div>
      </div>
    `
    );

    scrollBottom_(root);
  }

  async function ask_(root, state) {
    if (state.isAsking || state.isUploading) return;

    const input = root.querySelector("[data-ab-input]");
    const send = root.querySelector("[data-ab-send]");
    const question = input.value.trim();

    if (!question) return;

    state.isAsking = true;
    send.disabled = true;
    input.disabled = true;
    input.value = "";

    addUserMessage_(root, question);

    state.history.push({
      role: "user",
      text: question
    });

    const loaderId = addLoader_(root, "Finding the closest help topics");

    try {
      const response = await callGas_(state.gasUrl, {
        action: "ask",
        token: state.token || "",
        orgId: state.orgId,
        userId: state.userId,
        userName: state.userName,
        userEmail: state.userEmail,
        contexts: state.contexts,
        question: question
      });

      removeLoader_(root, loaderId);

      if (!response.ok) {
        addBotMessage_(root, response.error || "Could not process your question.", true);
        return;
      }

      if (typeof response.score === "number") {
        alert("Best matching score: " + response.score);
      }

      const matches = Array.isArray(response.matches) ? response.matches : [];
      const actionChip = response.actionChip || response.ticketChip || null;

      if (!matches.length) {
        addBotMessage_(
          root,
          response.answer ||
            "The bot could not find matching topic to your question. Kindly consult with your organization admin."
        );

        renderActionOnly_(root, state, actionChip);
        return;
      }

      addBotHtmlMessage_(root, "<strong>Choose the closest matching topic:</strong>");
      renderMatchChips_(root, state, matches, actionChip);
    } catch (err) {
      removeLoader_(root, loaderId);
      addBotMessage_(root, err.message || String(err), true);
    } finally {
      state.isAsking = false;
      send.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  function renderMatchChips_(root, state, matches, actionChip) {
    const body = root.querySelector("[data-ab-body]");
    state.lastMatches = matches;

    const chips = matches
      .map(function (item, index) {
        return `
          <button class="ab-match-chip" type="button" data-ab-match="${index}">
            ${escapeHtml_(item.title || item.subchunk_name || item.chunk_name || "Topic")}
          </button>
        `;
      })
      .join("");

    const actionHtml = renderActionChipHtml_(actionChip);

    const row = document.createElement("div");
    row.className = "ab-match-row";
    row.innerHTML = chips + actionHtml;

    body.appendChild(row);

    row.querySelectorAll("[data-ab-match]").forEach(function (button) {
      button.addEventListener("click", function () {
        const index = Number(button.getAttribute("data-ab-match"));
        showChunk_(root, state, state.lastMatches[index]);
      });
    });

    bindActionChip_(row, root, state, actionChip);

    scrollBottom_(root);
  }

  function renderActionOnly_(root, state, actionChip) {
    const body = root.querySelector("[data-ab-body]");
    const row = document.createElement("div");

    row.className = "ab-match-row";
    row.innerHTML = renderActionChipHtml_(actionChip);

    body.appendChild(row);

    bindActionChip_(row, root, state, actionChip);

    scrollBottom_(root);
  }

  function renderActionChipHtml_(actionChip) {
    if (!actionChip) {
      return "";
    }

    const label = actionChip.label || "Raise a ticket";
    const type = actionChip.type || "ticket";

    if (type === "sales" || type === "support_email") {
      return `
        <button class="ab-ticket-chip ab-sales-chip" type="button" data-ab-contact-actions>
          ${escapeHtml_(label)}
        </button>
      `;
    }

    return `
      <button class="ab-ticket-chip" type="button" data-ab-ticket>
        ${escapeHtml_(label)}
      </button>
    `;
  }

  function bindActionChip_(row, root, state, actionChip) {
    if (!actionChip) {
      return;
    }

    if (actionChip.type === "sales" || actionChip.type === "support_email") {
      const contact = row.querySelector("[data-ab-contact-actions]");

      if (contact) {
        contact.addEventListener("click", function () {
          renderContactActions_(root, actionChip);
        });
      }

      return;
    }

    /*
      Existing support flow remains unchanged.
      Ticket chips still call the GAS ticket action through raiseTicket_().
    */
    const ticket = row.querySelector("[data-ab-ticket]");

    if (ticket) {
      ticket.addEventListener("click", function () {
        raiseTicket_(root, state);
      });
    }
  }

  function renderContactActions_(root, actionChip) {
    const actions = Array.isArray(actionChip.actions) ? actionChip.actions : [];

    const message =
      actionChip.message ||
      "Please contact Ander Baher sales for onboarding, pricing, payment, or package-related help.";

    if (!actions.length) {
      addBotMessage_(root, message);
      return;
    }

    const linksHtml = actions
      .map(function (item) {
        const label = item.label || item.type || "Open";
        const type = String(item.type || "link").trim().toLowerCase();
        const url = String(item.url || "").trim();

        if (!url || !isAllowedActionUrl_(url)) {
          return "";
        }

        return `
          <a
            class="ab-action-link ab-action-link-${escapeAttr_(type)}"
            href="${escapeAttr_(url)}"
            target="${getActionTarget_(url)}"
            rel="noopener"
          >
            ${escapeHtml_(label)}
          </a>
        `;
      })
      .join("");

    if (!linksHtml.trim()) {
      addBotMessage_(root, message);
      return;
    }

    addBotHtmlMessage_(
      root,
      `
        <div class="ab-sales-actions">
          <div class="ab-sales-message">${escapeHtml_(message)}</div>
          <div class="ab-sales-action-row">
            ${linksHtml}
          </div>
        </div>
      `
    );
  }

  function isAllowedActionUrl_(url) {
    url = String(url || "").trim().toLowerCase();

    return (
      url.indexOf("tel:") === 0 ||
      url.indexOf("mailto:") === 0 ||
      url.indexOf("https://wa.me/") === 0 ||
      url.indexOf("https://api.whatsapp.com/") === 0 ||
      url.indexOf("https://") === 0 ||
      url.indexOf("http://") === 0
    );
  }

  function getActionTarget_(url) {
    url = String(url || "").trim().toLowerCase();

    if (url.indexOf("http://") === 0 || url.indexOf("https://") === 0) {
      return "_blank";
    }

    return "_self";
  }

  function showChunk_(root, state, item) {
    if (!item) return;

    const body = root.querySelector("[data-ab-body]");
    const title = item.title || item.subchunk_name || item.chunk_name || "Help topic";
    const content = item.content || "";

    state.selectedChunks.push({
      chunk_id: item.chunk_id || "",
      title: title,
      content: content,
      score: item.score || ""
    });

    state.history.push({
      role: "assistant",
      text: "Displayed topic: " + title
    });

    const card = document.createElement("div");
    card.className = "ab-answer-card";

    const html = markdownToHtml_(content, title);

    card.innerHTML = html;
    body.appendChild(card);

    scrollBottom_(root);
  }

  async function uploadImage_(root, state, file) {
    if (!file) return;
    if (state.isUploading || state.isAsking) return;

    const allowedTypes = [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/webp",
      "image/gif"
    ];

    if (allowedTypes.indexOf(file.type) === -1) {
      addBotMessage_(
        root,
        "Only PNG, JPG, JPEG, WEBP, and GIF images can be uploaded.",
        true
      );
      return;
    }

    const maxBytes = 5 * 1024 * 1024;

    if (file.size > maxBytes) {
      addBotMessage_(
        root,
        "Image is too large. Please upload an image up to 5 MB.",
        true
      );
      return;
    }

    const uploadButton = root.querySelector("[data-ab-upload]");
    const sendButton = root.querySelector("[data-ab-send]");
    const loaderId = addLoader_(root, "Uploading image");

    state.isUploading = true;

    if (uploadButton) {
      uploadButton.disabled = true;
    }

    if (sendButton) {
      sendButton.disabled = true;
    }

    /*
      Only one uploaded image is allowed.
      When another image is selected, old preview and old session image are silently replaced.
      No alert is shown because the UI label says "Max 1".
    */
    if (state.uploadedImage) {
      if (state.uploadedImageMessageEl) {
        try {
          state.uploadedImageMessageEl.remove();
        } catch (err) {}

        state.uploadedImageMessageEl = null;
      }

      if (state.uploadedImage.previewUrl) {
        try {
          URL.revokeObjectURL(state.uploadedImage.previewUrl);
        } catch (err) {}
      }

      state.uploadedImage = null;
    }

    let localPreviewUrl = "";

    try {
      localPreviewUrl = URL.createObjectURL(file);

      const base64 = await fileToBase64_(file);

      const response = await callGas_(state.gasUrl, {
        action: "upload_image",
        token: state.token || "",
        orgId: state.orgId,
        userId: state.userId,
        userName: state.userName,
        userEmail: state.userEmail,
        contexts: state.contexts,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        base64: base64
      });

      removeLoader_(root, loaderId);

      if (!response.ok) {
        if (localPreviewUrl) {
          try {
            URL.revokeObjectURL(localPreviewUrl);
          } catch (err) {}
        }

        addBotMessage_(root, response.error || "Could not upload image.", true);
        return;
      }

      state.uploadedImage = {
        fileId: response.fileId || "",
        fileName: response.fileName || file.name,
        mimeType: response.mimeType || file.type,
        sizeBytes: response.sizeBytes || file.size,
        url: response.url || "",
        downloadUrl: response.downloadUrl || "",
        previewUrl: localPreviewUrl
      };

      state.uploadedImageMessageEl = addUploadedImagePreview_(
        root,
        state.uploadedImage
      );
    } catch (err) {
      removeLoader_(root, loaderId);

      if (localPreviewUrl) {
        try {
          URL.revokeObjectURL(localPreviewUrl);
        } catch (revokeErr) {}
      }

      addBotMessage_(root, err.message || String(err), true);
    } finally {
      state.isUploading = false;

      if (uploadButton) {
        uploadButton.disabled = false;
      }

      if (sendButton) {
        sendButton.disabled = false;
      }
    }
  }

  function fileToBase64_(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();

      reader.onload = function () {
        const result = String(reader.result || "");
        const commaIndex = result.indexOf(",");

        if (commaIndex === -1) {
          reject(new Error("Could not read image file."));
          return;
        }

        resolve(result.slice(commaIndex + 1));
      };

      reader.onerror = function () {
        reject(new Error("Could not read image file."));
      };

      reader.readAsDataURL(file);
    });
  }

  function addUploadedImagePreview_(root, file) {
    const body = root.querySelector("[data-ab-body]");

    /*
      Prefer direct Drive content/download URL.
      Fallback to normal Drive file URL.
    */
    const downloadUrl = file.downloadUrl || file.url || "";

    const row = document.createElement("div");
    row.className = "ab-message-row user ab-upload-preview-row";

    row.innerHTML = `
      <div class="ab-upload-preview-card">
        <div class="ab-upload-preview-title">
          Image Uploaded (Max 1):
        </div>

        ${
          downloadUrl
            ? `<a class="ab-action-link ab-upload-download-button" href="${escapeAttr_(downloadUrl)}" target="_blank" rel="noopener">
                Download
              </a>`
            : `<div class="ab-upload-preview-name">Image uploaded.</div>`
        }
      </div>
    `;

    body.appendChild(row);
    scrollBottom_(root);

    return row;
  }

  async function raiseTicket_(root, state) {
    const loaderId = addLoader_(root, "Creating support ticket");

    try {
      const response = await callGas_(state.gasUrl, {
        action: "ticket",
        token: state.token || "",
        orgId: state.orgId,
        userId: state.userId,
        userName: state.userName,
        userEmail: state.userEmail,
        contexts: state.contexts,
        history: state.history,
        selectedChunks: state.selectedChunks,
        uploadedImage: sanitizeUploadedImageForTicket_(state.uploadedImage)
      });

      removeLoader_(root, loaderId);

      if (!response.ok) {
        addBotMessage_(root, response.error || "Could not create ticket.", true);
        return;
      }

      const issueText = response.issueKey || "Support ticket";

      addBotMessage_(root, "Ticket created: " + issueText);

      if (response.issueUrl) {
        addBotMessage_(root, "Our support team can now review the request.");
      }
    } catch (err) {
      removeLoader_(root, loaderId);
      addBotMessage_(root, err.message || String(err), true);
    }
  }

  function sanitizeUploadedImageForTicket_(image) {
    if (!image) {
      return null;
    }

    return {
      fileId: image.fileId || "",
      fileName: image.fileName || "",
      mimeType: image.mimeType || "",
      sizeBytes: image.sizeBytes || "",
      url: image.url || "",
      downloadUrl: image.downloadUrl || ""
    };
  }

  async function callGas_(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      redirect: "follow",
      body: JSON.stringify(payload)
    });

    const text = await res.text();

    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error("Invalid server response: " + text.slice(0, 200));
    }
  }

  function addUserMessage_(root, text) {
    const body = root.querySelector("[data-ab-body]");

    body.insertAdjacentHTML(
      "beforeend",
      `
      <div class="ab-message-row user">
        <div class="ab-bubble">${escapeHtml_(text)}</div>
      </div>
    `
    );

    scrollBottom_(root);
  }

  function addBotMessage_(root, text, isError) {
    const body = root.querySelector("[data-ab-body]");

    body.insertAdjacentHTML(
      "beforeend",
      `
      <div class="ab-message-row bot ${isError ? "error" : ""}">
        <div class="ab-bubble">${escapeHtml_(text)}</div>
      </div>
    `
    );

    scrollBottom_(root);
  }

  function addLoader_(root, label) {
    const body = root.querySelector("[data-ab-body]");
    const id = "loader_" + Date.now() + "_" + Math.floor(Math.random() * 10000);

    body.insertAdjacentHTML(
      "beforeend",
      `
      <div class="ab-message-row bot" data-loader-id="${id}">
        <div class="ab-bubble">
          <span class="ab-loader-bubble">
            <span>${escapeHtml_(label || "Please wait")}</span>
            <span class="ab-loader-dot"></span>
            <span class="ab-loader-dot"></span>
            <span class="ab-loader-dot"></span>
          </span>
        </div>
      </div>
    `
    );

    scrollBottom_(root);
    return id;
  }

  function removeLoader_(root, id) {
    const el = root.querySelector('[data-loader-id="' + id + '"]');
    if (el) el.remove();
  }

  function markdownToHtml_(markdown, fallbackTitle) {
    const raw = String(markdown || "").trim();

    if (!raw) {
      return "<p>No content available.</p>";
    }

    const lines = raw.split(/\r?\n/);
    const html = [];
    let inList = false;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();

      if (!line) {
        if (inList) {
          html.push("</ul>");
          inList = false;
        }
        continue;
      }

      if (/^####\s+/.test(line)) {
        if (inList) {
          html.push("</ul>");
          inList = false;
        }
        html.push("<h4>" + inlineMarkdown_(line.replace(/^####\s+/, "")) + "</h4>");
        continue;
      }

      if (/^###\s+/.test(line)) {
        if (inList) {
          html.push("</ul>");
          inList = false;
        }
        html.push("<h3>" + inlineMarkdown_(line.replace(/^###\s+/, "")) + "</h3>");
        continue;
      }

      if (/^##\s+/.test(line)) {
        if (inList) {
          html.push("</ul>");
          inList = false;
        }
        html.push("<h2>" + inlineMarkdown_(line.replace(/^##\s+/, "")) + "</h2>");
        continue;
      }

      if (/^#\s+/.test(line)) {
        if (inList) {
          html.push("</ul>");
          inList = false;
        }
        html.push("<h1>" + inlineMarkdown_(line.replace(/^#\s+/, "")) + "</h1>");
        continue;
      }

      if (/^[-*]\s+/.test(line)) {
        if (!inList) {
          html.push("<ul>");
          inList = true;
        }

        html.push("<li>" + inlineMarkdown_(line.replace(/^[-*]\s+/, "")) + "</li>");
        continue;
      }

      if (inList) {
        html.push("</ul>");
        inList = false;
      }

      html.push("<p>" + inlineMarkdown_(line) + "</p>");
    }

    if (inList) {
      html.push("</ul>");
    }

    const hasHeading = /^#{1,4}\s+/m.test(raw);

    if (!hasHeading && fallbackTitle) {
      return "<h3>" + escapeHtml_(fallbackTitle) + "</h3>" + html.join("");
    }

    return html.join("");
  }

  function inlineMarkdown_(text) {
    return escapeHtml_(text)
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function scrollBottom_(root) {
    const body = root.querySelector("[data-ab-body]");
    body.scrollTop = body.scrollHeight;
  }

  function normalizeConfig_(root, options) {
    return {
      gasUrl: options.gasUrl || root.getAttribute("data-gas-url") || "",
      token: options.token || root.getAttribute("data-token") || "",
      orgId: options.orgId || root.getAttribute("data-org-id") || "",
      userId: options.userId || root.getAttribute("data-user-id") || "",
      userName: options.userName || root.getAttribute("data-user-name") || "",
      userEmail: options.userEmail || root.getAttribute("data-user-email") || "",
      contexts: options.contexts || root.getAttribute("data-contexts") || "",
      title: options.title || root.getAttribute("data-title") || "Support Assistant",
      placeholder: options.placeholder || "Ask a question...",
      sendLabel: options.sendLabel || "Send",
      suggestions: options.suggestions || null
    };
  }

  function formatContextLine_(cfg) {
    const parts = [];

    if (cfg.orgId) parts.push(cfg.orgId);

    if (Array.isArray(cfg.contexts)) {
      if (cfg.contexts.length) parts.push(cfg.contexts.join(", "));
    } else if (cfg.contexts) {
      parts.push(cfg.contexts);
    }

    return parts.join(" • ");
  }

  function escapeHtml_(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr_(value) {
    return escapeHtml_(value).replace(/`/g, "&#096;");
  }

  window.ABChatbot = ABChatbot;
})();