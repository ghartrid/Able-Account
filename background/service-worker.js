// Cross-browser namespace
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Check overdue accounts every 4 hours
browserAPI.alarms.create('checkOverdue', { periodInMinutes: 240 });

// Also check on install/startup
browserAPI.runtime.onInstalled.addListener(() => {
  checkOverdueAccounts();
});

browserAPI.runtime.onStartup.addListener(() => {
  checkOverdueAccounts();
});

browserAPI.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkOverdue') {
    checkOverdueAccounts();
  }
});

async function checkOverdueAccounts() {
  try {
    const data = await browserAPI.storage.local.get(['overdueCount', 'overdueNames']);
    const count = data.overdueCount || 0;
    const names = data.overdueNames || [];
    updateBadge(count);

    if (count > 0) {
      // Don't spam — only notify once every 4 hours
      const lastNotified = await browserAPI.storage.local.get('lastNotifiedTime');
      const now = Date.now();
      const fourHoursMs = 4 * 60 * 60 * 1000;

      if (!lastNotified.lastNotifiedTime || (now - lastNotified.lastNotifiedTime) >= fourHoursMs) {
        const nameList = names.slice(0, 3).join(', ');
        const extra = count > 3 ? ` and ${count - 3} more` : '';
        const message = count === 1
          ? `${names[0] || 'An account'} needs a password refresh.`
          : `${nameList}${extra} need password refreshes.`;

        browserAPI.notifications.create('overdueReminder-' + now, {
          type: 'basic',
          iconUrl: browserAPI.runtime.getURL('icons/icon128.png'),
          title: 'Able Account - Passwords Overdue!',
          message: message,
          priority: 2,
          requireInteraction: true
        });

        await browserAPI.storage.local.set({ lastNotifiedTime: now });
      }
    }
  } catch (err) {
    console.error('Error checking overdue accounts:', err);
  }
}

function updateBadge(count) {
  if (count > 0) {
    browserAPI.action.setBadgeText({ text: String(count) });
    browserAPI.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else {
    browserAPI.action.setBadgeText({ text: '' });
  }
}

// Listen for messages from popup and content scripts
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'updateOverdueCount') {
    browserAPI.storage.local.set({
      overdueCount: message.count,
      overdueNames: message.names || []
    });
    updateBadge(message.count);
  }

  // Content script detected a new signup
  if (message.type === 'newAccountDetected') {
    // Validate required fields before processing
    const data = message.data;
    if (data && typeof data.service_name === 'string' && typeof data.url === 'string') {
      handleNewAccountDetected({
        service_name: data.service_name.slice(0, 200),
        url: data.url.slice(0, 200),
        username: typeof data.username === 'string' ? data.username.slice(0, 200) : ''
      });
    }
  }

  // Popup asking for pending detected accounts
  if (message.type === 'getPendingAccounts') {
    browserAPI.storage.local.get('pendingAccounts').then(data => {
      sendResponse(data.pendingAccounts || []);
    });
    return true; // keep channel open for async response
  }

  // Popup clearing pending accounts
  if (message.type === 'clearPendingAccounts') {
    browserAPI.storage.local.set({ pendingAccounts: [] });
  }

  // Content script detected an OAuth button click
  if (message.type === 'oauthStarted' && message.data && typeof message.data.domain === 'string') {
    browserAPI.storage.local.set({ oauthPending: message.data });
  }
});

async function handleNewAccountDetected(accountData) {
  // Store in pending list for popup to pick up
  const data = await browserAPI.storage.local.get('pendingAccounts');
  const pending = data.pendingAccounts || [];

  // Don't add duplicates (same domain)
  if (pending.some(p => p.url === accountData.url)) return;

  pending.push({
    service_name: accountData.service_name,
    url: accountData.url,
    username: accountData.username,
    detected_at: new Date().toISOString()
  });

  await browserAPI.storage.local.set({ pendingAccounts: pending });

  // Show a notification
  browserAPI.notifications.create('newAccount-' + Date.now(), {
    type: 'basic',
    iconUrl: browserAPI.runtime.getURL('icons/icon128.png'),
    title: 'Able Account - New Account Detected',
    message: `${accountData.service_name} (${accountData.url}) was added to your account list.`,
    priority: 1
  });
}

// Open popup when user clicks a notification
browserAPI.notifications.onClicked.addListener(() => {
  try {
    browserAPI.action.openPopup();
  } catch (e) {
    // openPopup may fail if user gesture is not available — ignore
  }
});
