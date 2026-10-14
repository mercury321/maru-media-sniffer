const prefix = document.querySelector("#prefix"); const saveAs = document.querySelector("#saveAs"); const status = document.querySelector("#status");
chrome.storage.sync.get({ prefix: "", saveAs: true }, value => { prefix.value = value.prefix; saveAs.checked = value.saveAs; });
document.querySelector("#save").onclick = () => chrome.storage.sync.set({ prefix: prefix.value.trim(), saveAs: saveAs.checked }, () => { status.textContent = "设置已保存"; setTimeout(() => status.textContent = "", 1800); });
