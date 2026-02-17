// Cross-browser namespace
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Check overdue accounts daily
browserAPI.alarms.create('checkOverdue', { periodInMinutes: 1440 });

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
    const stored = await browserAPI.storage.local.get('accountDB');
    if (!stored.accountDB) {
      updateBadge(0);
      return;
    }

    // Parse the stored DB to count overdue accounts
    // We read the raw data to avoid loading sql.js in the service worker
    // Instead, we use a simpler approach: store overdue count alongside the DB
    const countData = await browserAPI.storage.local.get('overdueCount');
    const count = countData.overdueCount || 0;
    updateBadge(count);

    if (count > 0) {
      browserAPI.notifications.create('overdueReminder', {
        type: 'basic',
        iconUrl: browserAPI.runtime.getURL('icons/icon128.png'),
        title: 'Password Refresh Reminder',
        message: count === 1
          ? '1 account needs a password refresh.'
          : `${count} accounts need a password refresh.`,
        priority: 1
      });
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

// Listen for messages from popup to update overdue count
browserAPI.runtime.onMessage.addListener((message) => {
  if (message.type === 'updateOverdueCount') {
    browserAPI.storage.local.set({ overdueCount: message.count });
    updateBadge(message.count);
  }
});
