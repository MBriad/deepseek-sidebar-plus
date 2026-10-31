const ENDPOINT = 'http://127.0.0.1:3080/';
const frame = document.getElementById('frame');
const offline = document.getElementById('offline');
const statusEl = document.getElementById('status');
let timer = 0;

async function probe() {
  statusEl.textContent = '检测中…';
  try {
    await fetch(ENDPOINT, { mode: 'no-cors', cache: 'no-store' });
    showOnline();
  } catch {
    showOffline();
  }
}

function showOnline() {
  clearInterval(timer);
  statusEl.textContent = '已连接';
  offline.hidden = true;
  frame.hidden = false;
  if (frame.src !== ENDPOINT) frame.src = ENDPOINT;
}

function showOffline() {
  statusEl.textContent = '未运行';
  frame.hidden = true;
  offline.hidden = false;
  clearInterval(timer);
  timer = setInterval(async () => {
    try {
      await fetch(ENDPOINT, { mode: 'no-cors', cache: 'no-store' });
      showOnline();
    } catch {
      // 继续等。
    }
  }, 3000);
}

document.getElementById('retry').addEventListener('click', probe);
document.getElementById('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById('command').textContent);
    document.getElementById('copy').textContent = '已复制';
    setTimeout(() => { document.getElementById('copy').textContent = '复制命令'; }, 1500);
  } catch {
    // 手动选中即可。
  }
});

probe();