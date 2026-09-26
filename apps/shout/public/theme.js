// Applied before first paint so the chosen theme never flashes.
try {
  const theme = localStorage.getItem('shout.theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
