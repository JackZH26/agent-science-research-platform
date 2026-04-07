// ============================================================
// ASRP Assistant Chat Panel — T-033 through T-038
// Floating panel in bottom-right, persists across navigation.
// Toggle: Cmd/Ctrl+J
// ============================================================

(function () {
  'use strict';

  // ---- State ----
  var panelState = 'collapsed'; // 'collapsed' | 'expanded' | 'fullscreen'
  var messages = [];
  var currentModel = { model: 'Claude Sonnet 4.6', type: 'cloud' };
  var isLoading = false;

  // T-038: Quick action buttons
  var QUICK_ACTIONS = [
    { label: '🧪 Register research', msg: 'How do I register an research?' },
    { label: '🔄 Switch agent model', msg: 'How do I switch an agent model?' },
    { label: '📄 Paper pipeline', msg: 'What is the current paper pipeline status?' },
  ];

  // ---- Create panel HTML ----
  function createPanel() {
    var panel = document.createElement('div');
    panel.id = 'assistant-panel';
    panel.setAttribute('aria-label', 'ASRP Assistant');
    panel.innerHTML = [
      '<div id="ap-header">',
      '  <div id="ap-header-left">',
      '    <span id="ap-icon">✨</span>',
      '    <span id="ap-title">Assistant</span>',
      '    <span id="ap-model-badge"></span>',
      '  </div>',
      '  <div id="ap-header-right">',
      '    <button id="ap-btn-fullscreen" title="Fullscreen" aria-label="Fullscreen">⤢</button>',
      '    <button id="ap-btn-minimize" title="Collapse" aria-label="Collapse">−</button>',
      '    <button id="ap-btn-close" title="Close" aria-label="Close">×</button>',
      '  </div>',
      '</div>',
      '<div id="ap-body">',
      '  <div id="ap-quick-actions"></div>',
      '  <div id="ap-messages" aria-live="polite"></div>',
      '  <div id="ap-typing" style="display:none">',
      '    <div class="ap-typing-dot"></div>',
      '    <div class="ap-typing-dot"></div>',
      '    <div class="ap-typing-dot"></div>',
      '  </div>',
      '</div>',
      '<div id="ap-footer">',
      '  <div id="ap-model-row">',
      '    <span id="ap-model-info"></span>',
      '    <button id="ap-model-toggle" title="Switch model">Switch</button>',
      '    <button id="ap-clear-btn" title="Clear history">🗑</button>',
      '  </div>',
      '  <div id="ap-input-row">',
      '    <textarea id="ap-input" placeholder="Ask anything…" rows="1" aria-label="Message"></textarea>',
      '    <button id="ap-send-btn" title="Send (Enter)" aria-label="Send">➤</button>',
      '  </div>',
      '</div>',
    ].join('');

    document.body.appendChild(panel);
    injectStyles();
    return panel;
  }

  // ---- Styles ----
  function injectStyles() {
    if (document.getElementById('ap-styles')) return;
    var s = document.createElement('style');
    s.id = 'ap-styles';
    s.textContent = [
      /* Panel container */
      '#assistant-panel {',
      '  position: fixed;',
      '  bottom: 20px;',
      '  right: 20px;',
      '  width: 340px;',
      '  max-height: 520px;',
      '  background: #ffffff;',
      '  border: 1px solid #e2e8e2;',
      '  border-radius: 14px;',
      '  box-shadow: 0 8px 32px rgba(0,0,0,0.14), 0 2px 8px rgba(74,140,106,0.10);',
      '  display: flex;',
      '  flex-direction: column;',
      '  z-index: 9999;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
      '  font-size: 13px;',
      '  transition: all 0.22s cubic-bezier(0.4, 0, 0.2, 1);',
      '  overflow: hidden;',
      '}',
      '#assistant-panel.ap-collapsed {',
      '  max-height: 44px;',
      '  width: 200px;',
      '}',
      '#assistant-panel.ap-fullscreen {',
      '  bottom: 0; right: 0; left: 0; top: 0;',
      '  width: 100%; max-height: 100%;',
      '  border-radius: 0;',
      '}',
      '#assistant-panel.ap-hidden { display: none; }',
      /* Header */
      '#ap-header {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  padding: 10px 12px;',
      '  background: linear-gradient(135deg, #4a8c6a 0%, #3d7558 100%);',
      '  color: white;',
      '  border-radius: 14px 14px 0 0;',
      '  flex-shrink: 0;',
      '  cursor: pointer;',
      '  user-select: none;',
      '}',
      '.ap-collapsed #ap-header { border-radius: 14px; }',
      '#ap-header-left { display: flex; align-items: center; gap: 6px; }',
      '#ap-icon { font-size: 15px; }',
      '#ap-title { font-weight: 600; font-size: 13px; }',
      '#ap-model-badge {',
      '  font-size: 10px;',
      '  background: rgba(255,255,255,0.2);',
      '  border-radius: 8px;',
      '  padding: 1px 6px;',
      '  white-space: nowrap;',
      '}',
      '#ap-header-right { display: flex; gap: 2px; }',
      '#ap-header-right button {',
      '  background: none;',
      '  border: none;',
      '  color: rgba(255,255,255,0.85);',
      '  cursor: pointer;',
      '  font-size: 14px;',
      '  padding: 2px 5px;',
      '  border-radius: 4px;',
      '  line-height: 1;',
      '  transition: background 0.15s;',
      '}',
      '#ap-header-right button:hover { background: rgba(255,255,255,0.2); color: white; }',
      /* Body */
      '#ap-body {',
      '  display: flex;',
      '  flex-direction: column;',
      '  flex: 1;',
      '  overflow: hidden;',
      '  min-height: 0;',
      '}',
      '.ap-collapsed #ap-body { display: none; }',
      /* Quick actions */
      '#ap-quick-actions {',
      '  display: flex;',
      '  flex-wrap: wrap;',
      '  gap: 4px;',
      '  padding: 8px 10px 4px;',
      '  border-bottom: 1px solid #f0f0f0;',
      '  flex-shrink: 0;',
      '}',
      '.ap-quick-btn {',
      '  background: #f4f7f4;',
      '  border: 1px solid #e0e8e0;',
      '  border-radius: 12px;',
      '  padding: 3px 9px;',
      '  font-size: 11px;',
      '  cursor: pointer;',
      '  color: #3d7558;',
      '  transition: background 0.15s;',
      '  white-space: nowrap;',
      '}',
      '.ap-quick-btn:hover { background: #e8f2ec; border-color: #4a8c6a; }',
      /* Messages */
      '#ap-messages {',
      '  flex: 1;',
      '  overflow-y: auto;',
      '  padding: 10px;',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 8px;',
      '  min-height: 0;',
      '}',
      '.ap-msg {',
      '  max-width: 86%;',
      '  padding: 8px 11px;',
      '  border-radius: 12px;',
      '  line-height: 1.5;',
      '  word-wrap: break-word;',
      '  font-size: 13px;',
      '}',
      '.ap-msg.user {',
      '  align-self: flex-end;',
      '  background: #4a8c6a;',
      '  color: white;',
      '  border-bottom-right-radius: 4px;',
      '}',
      '.ap-msg.assistant {',
      '  align-self: flex-start;',
      '  background: #f4f7f4;',
      '  color: #1a2e24;',
      '  border-bottom-left-radius: 4px;',
      '  border: 1px solid #e0e8e0;',
      '}',
      '.ap-msg.assistant strong { color: #3d7558; }',
      '.ap-msg.assistant em { color: #6b7c6b; font-style: italic; }',
      /* Typing indicator */
      '#ap-typing {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 4px;',
      '  padding: 4px 14px 8px;',
      '  flex-shrink: 0;',
      '}',
      '.ap-typing-dot {',
      '  width: 6px; height: 6px;',
      '  background: #4a8c6a;',
      '  border-radius: 50%;',
      '  animation: ap-bounce 1.2s infinite;',
      '}',
      '.ap-typing-dot:nth-child(2) { animation-delay: 0.2s; }',
      '.ap-typing-dot:nth-child(3) { animation-delay: 0.4s; }',
      '@keyframes ap-bounce {',
      '  0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }',
      '  40% { transform: translateY(-5px); opacity: 1; }',
      '}',
      /* Footer */
      '#ap-footer { flex-shrink: 0; border-top: 1px solid #f0f0f0; }',
      '.ap-collapsed #ap-footer { display: none; }',
      '#ap-model-row {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '  padding: 5px 10px;',
      '  background: #fafcfa;',
      '  border-bottom: 1px solid #f0f0f0;',
      '}',
      '#ap-model-info {',
      '  flex: 1;',
      '  font-size: 11px;',
      '  color: #5a7a6a;',
      '}',
      '#ap-model-toggle, #ap-clear-btn {',
      '  background: none;',
      '  border: 1px solid #d0dcd0;',
      '  border-radius: 6px;',
      '  padding: 2px 7px;',
      '  font-size: 10px;',
      '  cursor: pointer;',
      '  color: #5a7a6a;',
      '  transition: all 0.15s;',
      '}',
      '#ap-model-toggle:hover, #ap-clear-btn:hover {',
      '  background: #e8f2ec;',
      '  border-color: #4a8c6a;',
      '  color: #3d7558;',
      '}',
      '#ap-input-row {',
      '  display: flex;',
      '  align-items: flex-end;',
      '  gap: 6px;',
      '  padding: 8px 10px;',
      '}',
      '#ap-input {',
      '  flex: 1;',
      '  border: 1px solid #d8e8d8;',
      '  border-radius: 10px;',
      '  padding: 7px 10px;',
      '  font-size: 13px;',
      '  font-family: inherit;',
      '  resize: none;',
      '  outline: none;',
      '  max-height: 80px;',
      '  overflow-y: auto;',
      '  line-height: 1.4;',
      '  color: #1a2e24;',
      '  background: #fafcfa;',
      '  transition: border-color 0.15s;',
      '}',
      '#ap-input:focus { border-color: #4a8c6a; background: #fff; }',
      '#ap-send-btn {',
      '  background: #4a8c6a;',
      '  border: none;',
      '  border-radius: 50%;',
      '  width: 32px;',
      '  height: 32px;',
      '  color: white;',
      '  font-size: 14px;',
      '  cursor: pointer;',
      '  flex-shrink: 0;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  transition: background 0.15s, transform 0.1s;',
      '}',
      '#ap-send-btn:hover { background: #3d7558; transform: scale(1.05); }',
      '#ap-send-btn:active { transform: scale(0.95); }',
      '#ap-send-btn:disabled { background: #b0c8b8; cursor: not-allowed; transform: none; }',
      /* Empty state */
      '.ap-empty {',
      '  text-align: center;',
      '  color: #8aaa9a;',
      '  font-size: 12px;',
      '  padding: 20px 10px;',
      '  line-height: 1.6;',
      '}',
      '.ap-empty .ap-empty-icon { font-size: 28px; margin-bottom: 6px; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ---- Render quick actions ----
  function renderQuickActions() {
    var container = document.getElementById('ap-quick-actions');
    if (!container) return;
    container.innerHTML = '';
    QUICK_ACTIONS.forEach(function (a) {
      var btn = document.createElement('button');
      btn.className = 'ap-quick-btn';
      btn.textContent = a.label;
      btn.addEventListener('click', function () { sendMessage(a.msg); });
      container.appendChild(btn);
    });
  }

  // ---- Render model info ----
  function renderModelInfo() {
    var el = document.getElementById('ap-model-info');
    var badge = document.getElementById('ap-model-badge');
    if (!el) return;
    el.textContent = '☁️ ' + currentModel.model;
    if (badge) badge.textContent = 'Cloud';
  }

  // ---- Render messages ----
  function renderMessages() {
    var container = document.getElementById('ap-messages');
    if (!container) return;

    container.innerHTML = '';

    if (messages.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'ap-empty';
      var emptyIcon = document.createElement('div');
      emptyIcon.className = 'ap-empty-icon';
      emptyIcon.textContent = '✨';
      var emptyText = document.createTextNode('Ask me anything about your research, researchs, or agents.');
      empty.appendChild(emptyIcon);
      empty.appendChild(emptyText);
      container.appendChild(empty);
      return;
    }

    messages.forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'ap-msg ' + m.role;
      buildFormattedContent(div, m.content);
      container.appendChild(div);
    });

    container.scrollTop = container.scrollHeight;
  }

  // ---- Safe markdown-ish text formatter using DOM API ----
  // Parses **bold**, *italic*, `code`, and newlines without innerHTML
  function buildFormattedContent(parent, text) {
    // Split by newlines first
    var lines = text.split('\n');
    for (var li = 0; li < lines.length; li++) {
      if (li > 0) parent.appendChild(document.createElement('br'));
      var line = lines[li];
      // Tokenize: **bold**, *italic*, `code`, plain text
      var regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
      var lastIdx = 0;
      var match;
      while ((match = regex.exec(line)) !== null) {
        // Plain text before this match
        if (match.index > lastIdx) {
          parent.appendChild(document.createTextNode(line.slice(lastIdx, match.index)));
        }
        var token = match[0];
        if (token.startsWith('**') && token.endsWith('**')) {
          var strong = document.createElement('strong');
          strong.textContent = token.slice(2, -2);
          parent.appendChild(strong);
        } else if (token.startsWith('`') && token.endsWith('`')) {
          var code = document.createElement('code');
          code.style.cssText = 'background:#e8f2ec;padding:1px 4px;border-radius:3px;font-family:monospace;font-size:12px';
          code.textContent = token.slice(1, -1);
          parent.appendChild(code);
        } else if (token.startsWith('*') && token.endsWith('*')) {
          var em = document.createElement('em');
          em.textContent = token.slice(1, -1);
          parent.appendChild(em);
        }
        lastIdx = match.index + token.length;
      }
      // Remaining plain text
      if (lastIdx < line.length) {
        parent.appendChild(document.createTextNode(line.slice(lastIdx)));
      }
    }
  }

  // ---- Send message ----
  function sendMessage(text) {
    text = (text || '').trim();
    if (!text || isLoading) return;

    messages.push({ role: 'user', content: text });
    renderMessages();

    var input = document.getElementById('ap-input');
    if (input) { input.value = ''; input.style.height = 'auto'; }

    setLoading(true);

    // T-036: Inject current page context
    var context = '';
    try {
      var hash = window.location.hash || '';
      var page = hash.replace('#', '').replace('/', '') || 'dashboard';
      context = 'User is on the ' + page + ' page';
    } catch (e) { /* ignore */ }

    if (window.asrp && window.asrp.assistant) {
      window.asrp.assistant.chat(text, context, currentModel.model).then(function (res) {
        setLoading(false);
        var reply = (res && res.reply) ? res.reply : 'Sorry, I could not process that request.';
        messages.push({ role: 'assistant', content: reply });
        renderMessages();
      }).catch(function () {
        setLoading(false);
        messages.push({ role: 'assistant', content: 'Error connecting to assistant.' });
        renderMessages();
      });
    } else {
      // Fallback when asrp bridge not ready
      setTimeout(function () {
        setLoading(false);
        messages.push({ role: 'assistant', content: 'Assistant is initializing… please try again shortly.' });
        renderMessages();
      }, 600);
    }
  }

  function setLoading(loading) {
    isLoading = loading;
    var typing = document.getElementById('ap-typing');
    var sendBtn = document.getElementById('ap-send-btn');
    if (typing) typing.style.display = loading ? 'flex' : 'none';
    if (sendBtn) sendBtn.disabled = loading;
  }

  // ---- Panel state management ----
  function setState(newState) {
    var panel = document.getElementById('assistant-panel');
    if (!panel) return;
    panelState = newState;
    panel.classList.remove('ap-collapsed', 'ap-fullscreen', 'ap-hidden');
    if (newState === 'collapsed') panel.classList.add('ap-collapsed');
    if (newState === 'fullscreen') panel.classList.add('ap-fullscreen');
    if (newState === 'hidden') panel.classList.add('ap-hidden');

    var btnMin = document.getElementById('ap-btn-minimize');
    var btnFs = document.getElementById('ap-btn-fullscreen');
    if (btnMin) btnMin.title = newState === 'collapsed' ? 'Expand' : 'Collapse';
    if (btnMin) btnMin.textContent = newState === 'collapsed' ? '+' : '−';
    if (btnFs) btnFs.title = newState === 'fullscreen' ? 'Exit fullscreen' : 'Fullscreen';
  }

  function toggle() {
    if (panelState === 'hidden' || panelState === 'collapsed') {
      setState('expanded');
    } else {
      setState('collapsed');
    }
  }

  // ---- Load history ----
  function loadHistory() {
    if (!window.asrp || !window.asrp.assistant) return;
    window.asrp.assistant.history().then(function (res) {
      if (res && res.messages && res.messages.length > 0) {
        messages = res.messages.map(function (m) {
          return { role: m.role, content: m.content };
        });
        renderMessages();
      }
    }).catch(function () { /* ignore */ });
  }

  // ---- Load model info ----
  function loadModel() {
    if (!window.asrp || !window.asrp.assistant) return;
    window.asrp.assistant.getModel().then(function (res) {
      if (res) {
        currentModel = { model: res.model, type: res.type };
        renderModelInfo();
      }
    }).catch(function () { /* ignore */ });
  }

  // ---- Init ----
  function init() {
    var panel = document.getElementById('assistant-panel');
    if (!panel) panel = createPanel();

    renderQuickActions();
    renderMessages();
    renderModelInfo();

    // Start collapsed
    setState('collapsed');

    // Load history and model after a short delay (wait for asrp bridge)
    setTimeout(function () {
      loadHistory();
      loadModel();
    }, 500);

    // Header click toggles collapse
    var header = document.getElementById('ap-header');
    if (header) {
      header.addEventListener('click', function (e) {
        if (e.target.id === 'ap-btn-minimize' ||
            e.target.id === 'ap-btn-fullscreen' ||
            e.target.id === 'ap-btn-close') return;
        toggle();
      });
    }

    // Minimize button
    var btnMin = document.getElementById('ap-btn-minimize');
    if (btnMin) {
      btnMin.addEventListener('click', function (e) {
        e.stopPropagation();
        if (panelState === 'collapsed') setState('expanded');
        else setState('collapsed');
      });
    }

    // Fullscreen button
    var btnFs = document.getElementById('ap-btn-fullscreen');
    if (btnFs) {
      btnFs.addEventListener('click', function (e) {
        e.stopPropagation();
        if (panelState === 'fullscreen') setState('expanded');
        else setState('fullscreen');
      });
    }

    // Close button
    var btnClose = document.getElementById('ap-btn-close');
    if (btnClose) {
      btnClose.addEventListener('click', function (e) {
        e.stopPropagation();
        setState('hidden');
      });
    }

    // Send button
    var sendBtn = document.getElementById('ap-send-btn');
    if (sendBtn) {
      sendBtn.addEventListener('click', function () {
        var input = document.getElementById('ap-input');
        if (input) sendMessage(input.value);
      });
    }

    // Input — Enter to send, Shift+Enter for newline
    var input = document.getElementById('ap-input');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage(input.value);
        }
      });
      input.addEventListener('input', function () {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 80) + 'px';
      });
    }

    // Model toggle button — cycle through available cloud models
    var CLOUD_MODELS = [
      { model: 'Gemini 2.5 Flash', type: 'cloud' },
      { model: 'Claude Sonnet 4.6', type: 'cloud' },
      { model: 'Claude Haiku 4.5', type: 'cloud' },
    ];

    var modelToggle = document.getElementById('ap-model-toggle');
    if (modelToggle) {
      modelToggle.addEventListener('click', function () {
        var curIdx = -1;
        for (var i = 0; i < CLOUD_MODELS.length; i++) {
          if (CLOUD_MODELS[i].model === currentModel.model) { curIdx = i; break; }
        }
        var nextIdx = (curIdx + 1) % CLOUD_MODELS.length;
        currentModel = CLOUD_MODELS[nextIdx];
        renderModelInfo();
        showToast('Switched to ' + currentModel.model, 'success', 2000);
      });
    }

    // Clear history button
    var clearBtn = document.getElementById('ap-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        if (!confirm('Clear chat history?')) return;
        messages = [];
        renderMessages();
        if (window.asrp && window.asrp.assistant) {
          window.asrp.assistant.clearHistory().catch(function () { /* ignore */ });
        }
      });
    }

    // T-037: Keyboard shortcut Cmd/Ctrl+J (renderer-side fallback)
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        toggle();
        if (panelState !== 'collapsed' && panelState !== 'hidden') {
          var inp = document.getElementById('ap-input');
          if (inp) inp.focus();
        }
      }
    });

    // T-037: Listen for toggle event from main process
    if (window.asrp && window.asrp.assistant && window.asrp.assistant.onToggle) {
      window.asrp.assistant.onToggle(function () {
        toggle();
      });
    }

    // Expose toggle globally
    window.toggleAssistant = toggle;
  }

  // Helper: use global showToast if available
  function showToast(msg, type, duration) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, type, duration);
    }
  }

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
