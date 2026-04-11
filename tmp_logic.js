function loadActiveImage(srcUrl, pageUrl = window.location.href) {
    selectedImgSrc = srcUrl;
    selectedPageUrl = pageUrl;
    elPrev.src = selectedImgSrc || '';
    elPrev.style.display = selectedImgSrc ? 'block' : 'none';
    box.style.display = 'flex';
    elResultArea.style.display = 'none';
    elPreviewArea.style.display = 'none';
    elPreviewOut.textContent = '';
    elRaw.style.display = 'none';
    elOut.textContent = '';
    elRaw.textContent = '';
  }

  elPasteBtn.addEventListener('click', async function () {
    try {
      const clipboardItems = await navigator.clipboard.read();
      let foundImg = false;
      for (const item of clipboardItems) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            const reader = new FileReader();
            reader.onload = function(evt) { loadActiveImage(evt.target.result); };
            reader.readAsDataURL(blob);
            foundImg = true;
            return; // stop after first image
          }
        }
      }
      if (!foundImg) alert('No image found in clipboard.');
    } catch (err) {
      alert('Could not read clipboard. Ensure you granted permission to read it.');
      console.error(err);
    }
  });

  elUploadBtn.addEventListener('click', function () { elUploadInput.click(); });
  elUploadInput.addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(evt) { loadActiveImage(evt.target.result); };
    reader.readAsDataURL(file);
    elUploadInput.value = '';
  });

  box.addEventListener('dragover', function (e) { e.preventDefault(); });
  box.addEventListener('drop', function (e) {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      var file = e.dataTransfer.files[0];
      if (file.type.startsWith('image/')) {
        var reader = new FileReader();
        reader.onload = function(evt) { loadActiveImage(evt.target.result); };
        reader.readAsDataURL(file);
      }
    }
  });

  // Trigger from extension background.js Context Menu
  