// Able Account - Signup Form Detector
// Injected into web pages to detect account registration forms

(function () {
  'use strict';

  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

  // Track if we already prompted on this page
  let prompted = false;

  // --- Signup Detection ---

  // Keywords that indicate a signup form
  const SIGNUP_BUTTON_KEYWORDS = [
    'sign up', 'signup', 'create account', 'register', 'get started',
    'join now', 'join free', 'start free', 'create your account',
    'open account', 'set up account', 'make an account'
  ];

  const SIGNUP_URL_KEYWORDS = [
    '/signup', '/sign-up', '/register', '/create-account',
    '/join', '/enrollment', '/onboarding', '/new-account'
  ];

  const CONFIRM_PAGE_KEYWORDS = [
    '/welcome', '/success', '/confirm', '/verify',
    '/thank-you', '/thankyou', '/get-started',
    '/callback', '/auth/callback', '/oauth/callback',
    '/dashboard', '/home', '/account'
  ];

  // OAuth provider domains — when the user returns FROM these, they likely just signed up
  const OAUTH_PROVIDERS = [
    'accounts.google.com',
    'appleid.apple.com',
    'www.facebook.com',
    'github.com/login/oauth',
    'login.microsoftonline.com',
    'twitter.com/i/oauth',
    'x.com/i/oauth',
    'discord.com/oauth2',
    'login.yahoo.com',
    'amazon.com/ap/oa',
    'api.linkedin.com'
  ];

  // "Sign in with" button keywords for OAuth detection
  const OAUTH_BUTTON_KEYWORDS = [
    'sign in with', 'sign up with', 'continue with',
    'log in with', 'login with', 'register with',
    'connect with', 'sign in using', 'sign up using'
  ];

  function hasConfirmPasswordField(form) {
    const inputs = form.querySelectorAll('input[type="password"]');
    return inputs.length >= 2;
  }

  function hasSignupButton(form) {
    const buttons = form.querySelectorAll('button, input[type="submit"], a[role="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').toLowerCase().trim();
      if (SIGNUP_BUTTON_KEYWORDS.some(kw => text.includes(kw))) {
        return true;
      }
    }
    return false;
  }

  function isSignupURL() {
    const url = window.location.href.toLowerCase();
    return SIGNUP_URL_KEYWORDS.some(kw => url.includes(kw));
  }

  function isConfirmPage() {
    const url = window.location.href.toLowerCase();
    return CONFIRM_PAGE_KEYWORDS.some(kw => url.includes(kw));
  }

  function extractEmailFromForm(form) {
    const emailInput = form.querySelector(
      'input[type="email"], input[name*="email"], input[id*="email"], ' +
      'input[name*="user"], input[id*="user"], input[autocomplete="email"], ' +
      'input[autocomplete="username"]'
    );
    return emailInput ? emailInput.value : '';
  }

  function extractEmailFromPage() {
    const inputs = document.querySelectorAll('input[type="email"], input[name*="email"], input[autocomplete="email"]');
    for (const input of inputs) {
      if (input.value) return input.value;
    }
    return '';
  }

  function getDomain() {
    return window.location.hostname.replace(/^www\./, '');
  }

  function getServiceName() {
    // Try to get a clean service name from the page
    const domain = getDomain();
    // Use the domain without TLD as a readable name
    const parts = domain.split('.');
    if (parts.length >= 2) {
      // e.g. "netflix.com" -> "Netflix", "accounts.google.com" -> "Google"
      const name = parts.length > 2 ? parts[parts.length - 2] : parts[0];
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    return domain;
  }

  // --- OAuth Detection ---

  function checkOAuthReturn() {
    // Check if the user just came back from an OAuth provider
    const referrer = document.referrer;
    if (!referrer) return false;

    try {
      const refHost = new URL(referrer).hostname;
      const isFromOAuth = OAUTH_PROVIDERS.some(provider => {
        const providerHost = provider.split('/')[0];
        return refHost === providerHost || refHost.endsWith('.' + providerHost);
      });

      if (!isFromOAuth) return false;

      // We came from an OAuth provider — check if this looks like a first-time landing
      const url = window.location.href.toLowerCase();
      const isCallbackOrWelcome = CONFIRM_PAGE_KEYWORDS.some(kw => url.includes(kw))
        || url.includes('/oauth') || url.includes('/auth')
        || url.includes('/sso');

      const pageText = document.body?.innerText?.toLowerCase() || '';
      const welcomeSignals = [
        'welcome', 'get started', 'set up your', 'complete your profile',
        'account created', 'you\'re all set', 'thanks for joining',
        'choose a username', 'pick a plan', 'almost done',
        'finish setting up', 'one more step', 'personalize'
      ];
      const hasWelcomeText = welcomeSignals.some(s => pageText.includes(s));

      return isCallbackOrWelcome || hasWelcomeText;
    } catch (e) {
      return false;
    }
  }

  function watchOAuthButtons() {
    // Listen for clicks on OAuth buttons ("Sign in with Google", etc.)
    document.addEventListener('click', (e) => {
      if (prompted) return;

      const target = e.target.closest('button, a, [role="button"]');
      if (!target) return;

      const text = (target.textContent || target.getAttribute('aria-label') || '').toLowerCase().trim();
      const isOAuthBtn = OAUTH_BUTTON_KEYWORDS.some(kw => text.includes(kw));

      if (!isOAuthBtn) return;

      // Also check for OAuth provider logos/icons as a signal
      const hasProviderImg = target.querySelector('img[src*="google"], img[src*="apple"], img[src*="facebook"], img[src*="github"], img[src*="microsoft"]');
      const hasProviderText = /google|apple|facebook|github|microsoft|twitter|discord|linkedin|yahoo/i.test(text);

      if (isOAuthBtn && (hasProviderImg || hasProviderText)) {
        // Store the current domain so we can detect return
        const domain = getDomain();
        const serviceName = getServiceName();
        try {
          browserAPI.runtime.sendMessage({
            type: 'oauthStarted',
            data: { domain, serviceName, timestamp: Date.now() }
          });
        } catch (e) {
          // Fallback: use sessionStorage
          sessionStorage.setItem('ableAccountOAuth', JSON.stringify({
            domain, serviceName, timestamp: Date.now()
          }));
        }
      }
    }, true);
  }

  function checkOAuthSessionReturn() {
    // Check if we stored an OAuth start in sessionStorage and just returned
    try {
      const stored = sessionStorage.getItem('ableAccountOAuth');
      if (!stored) return;

      const data = JSON.parse(stored);
      const elapsed = Date.now() - data.timestamp;

      // If we're back on the same domain within 5 minutes, the OAuth completed
      if (getDomain() === data.domain && elapsed < 5 * 60 * 1000) {
        // Check for signs of a logged-in state
        const url = window.location.href.toLowerCase();
        const isPostAuth = CONFIRM_PAGE_KEYWORDS.some(kw => url.includes(kw))
          || url.includes('/dashboard') || url.includes('/home')
          || url.includes('/feed') || url.includes('/app');

        if (isPostAuth) {
          sessionStorage.removeItem('ableAccountOAuth');
          showPrompt('');
        }
      }

      // Expire after 5 minutes
      if (elapsed > 5 * 60 * 1000) {
        sessionStorage.removeItem('ableAccountOAuth');
      }
    } catch (e) {
      // Ignore
    }
  }

  // --- Notification Banner ---

  function showPrompt(username) {
    if (prompted) return;
    prompted = true;

    const domain = getDomain();
    const serviceName = getServiceName();

    // Create the notification banner
    const banner = document.createElement('div');
    banner.id = 'able-account-banner';
    banner.innerHTML = `
      <div id="able-account-inner">
        <div id="able-account-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#3b82f6" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div id="able-account-text">
          <strong>New account detected on ${serviceName}</strong>
          <span>Add <b>${domain}</b> to Able Account?</span>
        </div>
        <div id="able-account-actions">
          <button id="able-account-add">Add</button>
          <button id="able-account-dismiss">Dismiss</button>
        </div>
      </div>
    `;

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      #able-account-banner {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        animation: ableSlideIn 0.3s ease-out;
      }
      @keyframes ableSlideIn {
        from { transform: translateX(120%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes ableSlideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(120%); opacity: 0; }
      }
      #able-account-inner {
        display: flex;
        align-items: center;
        gap: 10px;
        background: #fff;
        border: 1px solid #e2e8f0;
        border-left: 4px solid #3b82f6;
        border-radius: 10px;
        padding: 12px 14px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.12);
        max-width: 380px;
      }
      #able-account-icon {
        flex-shrink: 0;
      }
      #able-account-text {
        flex: 1;
        line-height: 1.4;
      }
      #able-account-text strong {
        display: block;
        font-size: 13px;
        color: #1e293b;
        margin-bottom: 2px;
      }
      #able-account-text span {
        font-size: 12px;
        color: #64748b;
      }
      #able-account-text b {
        color: #475569;
      }
      #able-account-actions {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      }
      #able-account-add {
        padding: 6px 14px;
        background: #3b82f6;
        color: #fff;
        border: none;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s;
      }
      #able-account-add:hover {
        background: #2563eb;
      }
      #able-account-dismiss {
        padding: 6px 10px;
        background: #f1f5f9;
        color: #64748b;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        transition: background 0.15s;
      }
      #able-account-dismiss:hover {
        background: #e2e8f0;
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(banner);

    // Handle Add
    document.getElementById('able-account-add').addEventListener('click', () => {
      browserAPI.runtime.sendMessage({
        type: 'newAccountDetected',
        data: {
          service_name: serviceName,
          url: domain,
          username: username || ''
        }
      });
      dismissBanner(banner);
    });

    // Handle Dismiss
    document.getElementById('able-account-dismiss').addEventListener('click', () => {
      dismissBanner(banner);
    });

    // Auto-dismiss after 15 seconds
    setTimeout(() => {
      if (document.getElementById('able-account-banner')) {
        dismissBanner(banner);
      }
    }, 15000);
  }

  function dismissBanner(banner) {
    banner.style.animation = 'ableSlideOut 0.25s ease-in forwards';
    setTimeout(() => banner.remove(), 250);
  }

  // --- Form Submit Listener ---

  function watchForms() {
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!form || form.tagName !== 'FORM') return;

      const isSignup = (hasConfirmPasswordField(form) && (hasSignupButton(form) || isSignupURL()))
        || (hasSignupButton(form) && isSignupURL());

      if (isSignup) {
        const email = extractEmailFromForm(form);
        // Delay slightly so the form can submit
        setTimeout(() => showPrompt(email), 500);
      }
    }, true);
  }

  // --- Page Load Detection ---

  function checkOnLoad() {
    // Check if this looks like a post-signup confirmation page
    if (isConfirmPage()) {
      const pageText = document.body?.innerText?.toLowerCase() || '';
      const confirmPhrases = [
        'account created', 'registration complete', 'welcome to',
        'thanks for signing up', 'thank you for registering',
        'verify your email', 'check your email', 'account has been created',
        'successfully registered', 'you\'re all set'
      ];

      if (confirmPhrases.some(phrase => pageText.includes(phrase))) {
        const email = extractEmailFromPage();
        showPrompt(email);
      }
    }

    // Also scan for signup forms currently visible on the page
    const forms = document.querySelectorAll('form');
    for (const form of forms) {
      if (hasConfirmPasswordField(form) || (hasSignupButton(form) && isSignupURL())) {
        // This page has a signup form — watch for submission
        watchForms();
        return;
      }
    }
  }

  // --- MutationObserver for SPAs ---

  function watchForDynamicForms() {
    const observer = new MutationObserver(() => {
      if (prompted) return;
      const forms = document.querySelectorAll('form');
      for (const form of forms) {
        if (hasConfirmPasswordField(form) || (hasSignupButton(form) && isSignupURL())) {
          watchForms();
          return;
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- Init ---

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      checkOnLoad();
      watchForms();
      watchForDynamicForms();
      watchOAuthButtons();
      checkOAuthSessionReturn();
      if (checkOAuthReturn()) {
        showPrompt(extractEmailFromPage());
      }
    });
  } else {
    checkOnLoad();
    watchForms();
    watchForDynamicForms();
    watchOAuthButtons();
    checkOAuthSessionReturn();
    if (checkOAuthReturn()) {
      showPrompt(extractEmailFromPage());
    }
  }
})();
