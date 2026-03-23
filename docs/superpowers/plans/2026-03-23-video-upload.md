# Video Upload Feature — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the screenshot panel to support video uploads from the gallery, with multipart streaming, progress, and cancel support.

**Architecture:** Gallery picker accepts images + videos. Videos upload via multipart/form-data (XMLHttpRequest for progress). Server parses multipart with busboy, streams to disk via temp file. Path inserted into terminal identically to images.

**Tech Stack:** React Native (Expo), expo-image-picker, expo-file-system, XMLHttpRequest, Node.js http, busboy

**Spec:** `docs/superpowers/specs/2026-03-23-video-upload-design.md`

---

### Task 1: Install busboy on server

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Install busboy + types**

```bash
cd /Users/ayysir/Desktop/TMS\ Terminal/server
npm install busboy
npm install -D @types/busboy
```

- [ ] **Step 2: Verify installation**

```bash
cd /Users/ayysir/Desktop/TMS\ Terminal/server
node -e "require('busboy'); console.log('busboy OK')"
```

Expected: `busboy OK`

- [ ] **Step 3: Commit**

```bash
git add server/package.json server/package-lock.json
git commit -m "feat: add busboy dependency for multipart video uploads"
```

---

### Task 2: Add multipart upload handler on server

**Files:**
- Modify: `server/src/upload/upload.handler.ts`

- [ ] **Step 1: Add busboy import and constants**

Add the import at the **top of the file** (after line 6, alongside other imports):

```typescript
import Busboy from 'busboy';
```

Add the following constants after `MAX_BODY_SIZE` (after line 20):

```typescript
const MAX_MULTIPART_SIZE = 500 * 1024 * 1024; // 500 MB

const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/3gpp',
  'video/webm',
]);
```

- [ ] **Step 2: Add multipart handler function**

Add the `handleMultipartUpload` function after the existing `handleUpload` function (after line 93):

```typescript
function handleMultipartUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: UploadOptions,
): void {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token || !validateToken(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const dir = path.join(os.homedir(), 'Desktop', opts.outputDir);
  fs.mkdirSync(dir, { recursive: true });

  let fileSaved = false;
  let finalPath = '';
  let finalName = '';
  let tempPath = '';
  let responded = false;

  const respond = (status: number, body: object) => {
    if (responded) return;
    responded = true;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const cleanup = () => {
    if (tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  };

  let busboy: InstanceType<typeof Busboy>;
  try {
    busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_MULTIPART_SIZE, files: 1 },
    });
  } catch (err) {
    respond(400, { error: 'Invalid multipart request' });
    return;
  }

  busboy.on('file', (fieldname, file, info) => {
    const { filename, mimeType } = info;

    // Validate MIME type
    const isImage = mimeType.startsWith('image/');
    const isVideo = ALLOWED_VIDEO_MIMES.has(mimeType);
    if (!isImage && !isVideo) {
      file.resume(); // drain
      respond(400, { error: `Unsupported file type: ${mimeType}` });
      return;
    }

    const ext = path.extname(filename) || opts.defaultExt;
    const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    finalName = `${Date.now()}_${base}${ext}`;
    finalPath = path.join(dir, finalName);
    tempPath = finalPath + '.tmp';

    const writeStream = fs.createWriteStream(tempPath);

    file.on('limit', () => {
      writeStream.destroy();
      cleanup();
      respond(413, { error: 'File too large (max 500 MB)' });
    });

    file.pipe(writeStream);

    writeStream.on('finish', () => {
      // Rename temp → final
      try {
        fs.renameSync(tempPath, finalPath);
        fileSaved = true;
      } catch (err) {
        cleanup();
        respond(500, { error: 'Failed to save file' });
      }
    });

    writeStream.on('error', (err) => {
      cleanup();
      respond(500, { error: 'Write error' });
    });
  });

  busboy.on('finish', () => {
    if (fileSaved) {
      logger.success(`${opts.subDir} saved: ${finalPath}`);
      respond(200, { path: finalPath, filename: finalName });
    } else if (!responded) {
      cleanup();
      respond(400, { error: 'No file received' });
    }
  });

  busboy.on('error', (err) => {
    cleanup();
    respond(500, { error: 'Upload failed' });
  });

  req.on('close', () => {
    if (!fileSaved) cleanup();
  });

  req.pipe(busboy);
}
```

- [ ] **Step 3: Update the exported handlers to detect content-type**

Replace the existing `handleUploadRequest` function (lines 95-101) with content-type routing:

```typescript
export function handleUploadRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.includes('multipart/form-data')) {
    handleMultipartUpload(req, res, {
      outputDir: 'Screenshots',
      defaultExt: '.mp4',
      subDir: 'Media',
    });
  } else {
    handleUpload(req, res, {
      outputDir: 'Screenshots',
      defaultExt: '.jpg',
      subDir: 'Screenshot',
    });
  }
}
```

- [ ] **Step 4: Build and verify**

```bash
cd /Users/ayysir/Desktop/TMS\ Terminal/server
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/upload/upload.handler.ts
git commit -m "feat: add multipart upload handler for video support (busboy streaming)"
```

---

### Task 3: Add /upload/media route on server

**Files:**
- Modify: `server/src/index.ts:60-93`

- [ ] **Step 1: Add /upload/media route**

In `server/src/index.ts`, add a new route condition after the `/upload/screenshot` line (line 63). The `/upload/media` route points to the same handler:

```typescript
    } else if (req.url === '/upload/screenshot' || req.url === '/upload/media') {
      handleUploadRequest(req, res);
```

This replaces the existing line 63:
```typescript
    } else if (req.url === '/upload/screenshot') {
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/ayysir/Desktop/TMS\ Terminal/server
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "feat: add /upload/media route alias for video+image uploads"
```

---

### Task 4: Update gallery picker for images + videos

**Files:**
- Modify: `mobile/src/components/ScreenshotPanel.tsx:113-139`

- [ ] **Step 1: Update pickFromGallery**

Change the `launchImageLibraryAsync` call (lines 123-129) to accept all media types and remove `base64: true`:

```typescript
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsMultipleSelection: true,
        selectionLimit: MAX_GALLERY_SELECTION,
        quality: 1,
      });
```

Key changes:
- `MediaTypeOptions.Images` → `MediaTypeOptions.All`
- Removed `base64: true` (would crash on large videos)

- [ ] **Step 2: Update pickFromCamera to request base64 explicitly**

Camera remains image-only. Update lines 151-154 to keep `base64: true` since camera only captures photos:

```typescript
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        base64: true,
      });
```

- [ ] **Step 3: Verify the app still builds**

```bash
cd /Users/ayysir/Desktop/TMS\ Terminal/mobile
npx expo export --platform android --dev 2>&1 | head -5
```

Or just check TypeScript:
```bash
cd /Users/ayysir/Desktop/TMS\ Terminal/mobile
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add mobile/src/components/ScreenshotPanel.tsx
git commit -m "feat: gallery picker accepts images + videos, remove base64 for gallery"
```

---

### Task 5: Add video validation + video upload function

**Files:**
- Modify: `mobile/src/components/ScreenshotPanel.tsx`

- [ ] **Step 1: Add constants and imports**

Add at the top of the file, after existing imports (line 16):

```typescript
import * as FileSystem from 'expo-file-system';
```

Add after `MAX_GALLERY_SELECTION` (line 28):

```typescript
const MAX_VIDEO_DURATION_MS = 5 * 60 * 1000; // 5 minutes

const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/3gpp',
  'video/webm',
]);
```

- [ ] **Step 2: Add video validation helper**

Add after the `reset` callback (after line 51):

```typescript
  const validateVideo = useCallback((asset: ImagePicker.ImagePickerAsset): string | null => {
    if (asset.duration && asset.duration > MAX_VIDEO_DURATION_MS) {
      const mins = Math.round(asset.duration / 60000);
      return `Video zu lang (${mins} Min, max 5 Min)`;
    }
    if (asset.mimeType && !ALLOWED_VIDEO_MIMES.has(asset.mimeType)) {
      return `Format nicht unterstützt: ${asset.mimeType}`;
    }
    return null; // valid
  }, []);
```

- [ ] **Step 3: Add video multipart upload function with XHR progress**

Add a ref for the active XHR (for cancellation), after `copyTimerRef` (line 38):

```typescript
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const [videoProgress, setVideoProgress] = useState<{ loaded: number; total: number } | null>(null);
```

Add the upload function after `validateVideo`:

```typescript
  const uploadVideoMultipart = useCallback(async (asset: ImagePicker.ImagePickerAsset): Promise<string | null> => {
    const filename = asset.fileName ?? `video_${Date.now()}.mp4`;
    const uploadUrl = `http://${serverHost}:${serverPort}/upload/media`;

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setVideoProgress({ loaded: e.loaded, total: e.total });
        }
      };

      xhr.onload = () => {
        xhrRef.current = null;
        setVideoProgress(null);
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const json = JSON.parse(xhr.responseText) as { path: string };
            resolve(json.path);
          } catch {
            reject(new Error('Invalid server response'));
          }
        } else {
          reject(new Error(`Server error ${xhr.status}`));
        }
      };

      xhr.onerror = () => {
        xhrRef.current = null;
        setVideoProgress(null);
        reject(new Error('Upload fehlgeschlagen'));
      };

      xhr.ontimeout = () => {
        xhrRef.current = null;
        setVideoProgress(null);
        reject(new Error('Upload Timeout'));
      };

      xhr.onabort = () => {
        xhrRef.current = null;
        setVideoProgress(null);
        reject(new Error('Upload abgebrochen'));
      };

      xhr.open('POST', uploadUrl);
      xhr.timeout = 300000; // 5 minutes
      xhr.setRequestHeader('Authorization', `Bearer ${serverToken}`);

      const formData = new FormData();
      formData.append('file', {
        uri: asset.uri,
        type: asset.mimeType ?? 'video/mp4',
        name: filename,
      } as any);

      xhr.send(formData);
    });
  }, [serverHost, serverPort, serverToken]);
```

- [ ] **Step 4: Add cancel function**

After `uploadVideoMultipart`:

```typescript
  const cancelUpload = useCallback(() => {
    if (xhrRef.current) {
      xhrRef.current.abort();
      xhrRef.current = null;
    }
    setVideoProgress(null);
    reset();
  }, [reset]);
```

- [ ] **Step 5: Commit**

```bash
git add mobile/src/components/ScreenshotPanel.tsx
git commit -m "feat: add video validation, multipart upload with XHR progress + cancel"
```

---

### Task 6: Update uploadSingle + uploadMultiple for image/video branching

**Files:**
- Modify: `mobile/src/components/ScreenshotPanel.tsx`

- [ ] **Step 1: Update uploadSingle to read base64 from URI**

Since gallery no longer returns base64 (we removed `base64: true`), `uploadSingle` needs to read the file. Replace the existing `uploadSingle` function (lines 53-73):

```typescript
  const uploadSingle = useCallback(async (asset: ImagePicker.ImagePickerAsset): Promise<string | null> => {
    // Camera assets may have base64, gallery assets won't (we removed base64:true)
    let base64Data = asset.base64;
    if (!base64Data) {
      base64Data = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
    if (!base64Data) return null;

    const filename = asset.fileName ?? `screenshot_${Date.now()}.jpg`;
    const uploadUrl = `http://${serverHost}:${serverPort}/upload/screenshot`;

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serverToken}`,
      },
      body: JSON.stringify({
        filename,
        data: base64Data,
        mimeType: asset.mimeType ?? 'image/jpeg',
      }),
    });
    if (!response.ok) throw new Error(`Server error ${response.status}`);
    const json = await response.json() as { path: string };
    return json.path;
  }, [serverHost, serverPort, serverToken]);
```

- [ ] **Step 2: Update uploadMultiple to branch on asset type**

Replace the existing `uploadMultiple` function (lines 75-111). Capture `sessionId` at invocation time:

```typescript
  const uploadMultiple = useCallback(async (assets: ImagePicker.ImagePickerAsset[]) => {
    setUploadState('uploading');
    setUploadProgress({ current: 0, total: assets.length });

    // Capture sessionId now — user may switch tabs during long video uploads
    const capturedSessionId = sessionId;

    // Validate videos upfront
    for (const asset of assets) {
      if (asset.type === 'video') {
        const err = validateVideo(asset);
        if (err) {
          setUploadState('error');
          setErrorMsg(err);
          return;
        }
      }
    }

    const paths: string[] = [];
    const errors: string[] = [];

    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const isVideo = asset.type === 'video';
      const label = isVideo ? 'Video' : 'Bild';
      try {
        const path = isVideo
          ? await uploadVideoMultipart(asset)
          : await uploadSingle(asset);
        if (path) {
          paths.push(path);
          if (capturedSessionId) {
            wsService.send({ type: 'terminal:input', sessionId: capturedSessionId, payload: { data: path } });
          }
        } else {
          errors.push(`${label} ${i + 1}: keine Daten`);
        }
      } catch (err: unknown) {
        // Aborted uploads — stop entirely
        if (err instanceof Error && err.message === 'Upload abgebrochen') {
          return; // cancelUpload already reset state
        }
        errors.push(`${label} ${i + 1}: ${err instanceof Error ? err.message : 'Fehler'}`);
      }
      setUploadProgress({ current: i + 1, total: assets.length });
    }

    setUploadedPaths(paths);
    if (assets.length > 0) setPreviewUri(assets[0].uri);

    if (paths.length === 0) {
      setUploadState('error');
      setErrorMsg(errors.join('\n') || 'Keine Datei konnte hochgeladen werden');
    } else if (errors.length > 0) {
      setUploadState('done');
      setErrorMsg(`${errors.length} fehlgeschlagen`);
    } else {
      setUploadState('done');
    }
  }, [sessionId, wsService, uploadSingle, uploadVideoMultipart, validateVideo]);
```

- [ ] **Step 3: Commit**

```bash
git add mobile/src/components/ScreenshotPanel.tsx
git commit -m "feat: uploadMultiple branches on asset type (image base64 vs video multipart)"
```

---

### Task 7: Update UI — labels, progress, thumbnails, cancel button

**Files:**
- Modify: `mobile/src/components/ScreenshotPanel.tsx` (JSX + styles)
- Modify: `mobile/src/components/ToolRail.tsx:35`

- [ ] **Step 1: Update header icon and title**

Change line 178 (icon) from `"image"` to `"film"`:
```typescript
        <Feather name="film" size={ri(14)} color={colors.info} />
```

Change line 179 (title):
```typescript
        <Text style={[s.title, { fontSize: rf(13) }]}>Medien</Text>
```

- [ ] **Step 2: Update gallery button subtitle**

Change line 199:
```typescript
              <Text style={[s.primaryBtnSub, { fontSize: rf(10) }]}>Bilder & Videos (max 5 Min)</Text>
```

- [ ] **Step 3: Update hint text**

Change line 186:
```typescript
          <Text style={[s.hint, { fontSize: rf(11) }]}>Bild oder Video hochladen → Pfad ins Terminal</Text>
```

- [ ] **Step 4: Update loading state with video progress + cancel button**

Replace the loading section (lines 227-238) with:

```typescript
      {/* Loading */}
      {(uploadState === 'picking' || uploadState === 'uploading') && (
        <View style={s.centered}>
          <ActivityIndicator color={colors.info} size="large" />
          <Text style={s.loadingText}>
            {uploadState === 'picking'
              ? 'Galerie öffnet…'
              : videoProgress
                ? `${(videoProgress.loaded / (1024 * 1024)).toFixed(0)} MB / ${(videoProgress.total / (1024 * 1024)).toFixed(0)} MB`
                : uploadProgress.total > 1
                  ? `${uploadProgress.current}/${uploadProgress.total} hochgeladen…`
                  : 'Wird hochgeladen…'}
          </Text>
          {uploadState === 'uploading' && videoProgress && (
            <TouchableOpacity style={s.cancelBtn} onPress={cancelUpload} activeOpacity={0.75}>
              <Feather name="x" size={14} color={colors.destructive} />
              <Text style={s.cancelTxt}>Abbrechen</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
```

- [ ] **Step 5: Update done state — distinguish video count from image count**

Change line 261:
```typescript
              : `${uploadedPaths.length} Dateien hochgeladen`}
```

- [ ] **Step 6: Add video play overlay on thumbnail**

We need to track whether the first asset was a video. Add state after `previewUri` (around line 35):

```typescript
  const [previewIsVideo, setPreviewIsVideo] = useState(false);
```

In `uploadMultiple` (Task 6), after `setPreviewUri(assets[0].uri)`, add:

```typescript
    if (assets.length > 0) {
      setPreviewUri(assets[0].uri);
      setPreviewIsVideo(assets[0].type === 'video');
    }
```

Then in the done state JSX, after the existing `thumbBadge` view (around line 249), add the play icon overlay — only shown when `previewIsVideo`:

```typescript
              {previewIsVideo && (
                <View style={s.playOverlay}>
                  <Feather name="play" size={24} color="#fff" />
                </View>
              )}
```

Also reset it in `reset()`:
```typescript
    setPreviewIsVideo(false);
```

- [ ] **Step 7: Add play overlay style**

Add to the StyleSheet (after `thumbBadge` styles):

```typescript
  playOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
```

- [ ] **Step 8: Add cancel button styles**

Add to the StyleSheet (in the centered states section, after `loadingText`):

```typescript
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
    paddingVertical: 7,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(239,68,68,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.25)',
    borderRadius: 8,
  },
  cancelTxt: {
    color: colors.destructive,
    fontSize: 11,
    fontWeight: '600',
  },
```

- [ ] **Step 9: Update ToolRail label**

In `mobile/src/components/ToolRail.tsx` line 35, change:
```typescript
    { id: 'screenshots', icon: 'film',        color: colors.info,    label: 'Medien' },
```

- [ ] **Step 10: Commit**

```bash
git add mobile/src/components/ScreenshotPanel.tsx mobile/src/components/ToolRail.tsx
git commit -m "feat: update UI for video support — progress, cancel, labels, ToolRail"
```

---

### Task 8: Final build verification

- [ ] **Step 1: Build server**

```bash
cd /Users/ayysir/Desktop/TMS\ Terminal/server
npm run build
```

Expected: no errors.

- [ ] **Step 2: Check mobile TypeScript**

```bash
cd /Users/ayysir/Desktop/TMS\ Terminal/mobile
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: resolve build issues from video upload feature"
```

Only if Step 1 or 2 produced errors that needed fixing.
