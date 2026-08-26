const widgetSource = String.raw`(() => {
  "use strict";
  const script = document.currentScript;
  if (!script) return;
  const configurationToken = script.getAttribute("data-jormall-config");
  if (!configurationToken) return;
  const base = new URL(script.src).origin;
  const locale = script.getAttribute("data-locale") === "ar" ? "ar" : "en";
  let sessionToken = "";
  let labels;
  const host = document.createElement("div");
  host.setAttribute("data-jormall-ai-widget", "");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = base + "/ai-widget.css";
  root.append(stylesheet);

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  async function start() {
    const response = await fetch(base + "/api/ai/widget/session", {
      body: JSON.stringify({ configurationToken: configurationToken, locale: locale }),
      headers: { "content-type": "application/json" },
      method: "POST",
      mode: "cors"
    });
    if (!response.ok) throw new Error("WIDGET_SESSION_FAILED");
    const configuration = await response.json();
    sessionToken = configuration.sessionToken;
    labels = configuration.labels;
    host.style.setProperty("--jormall-primary", configuration.branding.primaryColor);
    host.style.setProperty("--jormall-accent", configuration.branding.accentColor);
    host.setAttribute("dir", configuration.direction);
    render(configuration);
  }

  function render(configuration) {
    const launcher = element("button", "launcher", labels.launcher);
    launcher.type = "button";
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-controls", "jormall-ai-panel");
    const panel = element("section", "panel");
    panel.id = "jormall-ai-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", configuration.branding.displayName);
    const header = element("header", "header");
    header.append(element("strong", "title", configuration.branding.displayName));
    const close = element("button", "close", "×");
    close.type = "button";
    close.setAttribute("aria-label", labels.close);
    header.append(close);
    const log = element("div", "log");
    log.setAttribute("aria-live", "polite");
    log.setAttribute("role", "log");
    const form = element("form", "composer");
    const messageLabel = element("label", "sr-only", labels.message);
    const input = element("input", "message");
    input.name = "message";
    input.maxLength = 5000;
    input.placeholder = labels.message;
    input.required = true;
    messageLabel.append(input);
    const send = element("button", "send", labels.send);
    send.type = "submit";
    form.append(messageLabel, send);
    panel.append(header, log);

    if (configuration.mockIdentityVerificationAvailable) {
      const details = element("details", "verification");
      const summary = element("summary", "verify-summary", labels.verify);
      const verifyForm = element("form", "verify-form");
      const phone = element("input", "verify-input");
      phone.placeholder = labels.verificationPhone;
      phone.setAttribute("aria-label", labels.verificationPhone);
      phone.required = true;
      const code = element("input", "verify-input");
      code.placeholder = labels.verificationCode;
      code.setAttribute("aria-label", labels.verificationCode);
      code.required = true;
      const verifyButton = element("button", "verify-button", labels.verify);
      verifyButton.type = "submit";
      verifyForm.append(phone, code, verifyButton);
      verifyForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        verifyButton.disabled = true;
        try {
          const response = await fetch(base + "/api/ai/widget/verify", {
            body: JSON.stringify({ phone: phone.value, sessionToken: sessionToken, verificationCode: code.value }),
            headers: { "content-type": "application/json" },
            method: "POST",
            mode: "cors"
          });
          if (!response.ok) throw new Error("VERIFY_FAILED");
          summary.textContent = labels.verified;
          details.open = false;
        } catch {
          appendMessage(log, labels.error, "assistant");
        } finally {
          verifyButton.disabled = false;
        }
      });
      details.append(summary, verifyForm);
      panel.append(details);
    }
    panel.append(form);
    root.append(panel, launcher);

    const toggle = (open) => {
      panel.hidden = !open;
      launcher.setAttribute("aria-expanded", String(open));
      if (open) input.focus();
    };
    launcher.addEventListener("click", () => toggle(panel.hidden));
    close.addEventListener("click", () => toggle(false));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      appendMessage(log, text, "customer");
      input.value = "";
      send.disabled = true;
      const assistant = appendMessage(log, "", "assistant");
      try {
        const response = await fetch(base + "/api/ai/widget/turn", {
          body: JSON.stringify({ message: text, requestId: crypto.randomUUID(), sessionToken: sessionToken }),
          headers: { "content-type": "application/json" },
          method: "POST",
          mode: "cors"
        });
        if (!response.ok || !response.body) throw new Error("TURN_FAILED");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          buffered += decoder.decode(part.value, { stream: true });
          const lines = buffered.split("\n");
          buffered = lines.pop() || "";
          for (const line of lines) {
            if (!line) continue;
            const event = JSON.parse(line);
            if (event.type === "token") assistant.textContent += event.text;
            if (event.type === "error") assistant.textContent = labels.error;
            if (event.type === "takeover") assistant.textContent = "";
          }
        }
        if (!assistant.textContent) assistant.remove();
      } catch {
        assistant.textContent = labels.error;
      } finally {
        send.disabled = false;
        input.focus();
      }
    });
  }

  function appendMessage(log, text, role) {
    const message = element("p", "bubble " + role, text);
    message.dir = "auto";
    log.append(message);
    log.scrollTop = log.scrollHeight;
    return message;
  }

  start().catch(() => {
    host.remove();
  });
})();`;

export function GET(): Response {
  return new Response(widgetSource, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
