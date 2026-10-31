// Player extension: the toolbar button opens the quality/caption settings.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
