import {
  isSpanMessage,
  validateSerializedSpan,
} from "@web-ai-otel/extension-transport/protocol";

const BRIDGE_TYPE = "web-ai-otel:bridge-span";

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }
  if (!isSpanMessage(event.data)) {
    return;
  }

  // Any script on the page can post to this channel, so the payload is
  // validated here before it reaches the privileged background context.
  const span = validateSerializedSpan(event.data.payload);
  if (!span) {
    return;
  }

  // Reloading the extension orphans this script: `chrome.runtime` goes away
  // and every later span would throw on the host page. Drop them quietly
  // instead; the page has to be reloaded to restore tracing.
  if (!chrome.runtime?.id) {
    return;
  }

  try {
    chrome.runtime
      .sendMessage({ type: BRIDGE_TYPE, payload: span })
      .catch(() => {
        // Background worker may be restarting.
      });
  } catch {
    // Context was invalidated between the check and the send.
  }
});
