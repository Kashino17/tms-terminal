# Video Upload Feature — Design Spec

**Date:** 2026-03-23
**Status:** Approved

## Summary

Extend the existing screenshot/image upload feature to also support video uploads from the mobile gallery. Videos are uploaded via multipart/form-data (not base64), stored in `~/Desktop/Screenshots/`, and the path is inserted into the active terminal session — identical to the existing image flow.

## Constraints

- Video source: gallery only (no live recording)
- Max duration: 5 minutes
- Storage: `~/Desktop/Screenshots/` (same as images)
- Max upload size: 500 MB (for videos via multipart; images keep 50 MB via base64)
- UI: combined panel (no separate tool)
- Camera button remains image-only (unchanged)

## Changes

### Mobile — `ScreenshotPanel.tsx`

1. **Gallery picker:** Change `mediaTypes` from `Images` to `All` (images + videos). **Important:** Remove `base64: true` from picker options — videos would crash the app if base64-encoded in memory. Instead, always use the `uri` from the picker result.
2. **Asset branching after selection:** Check `asset.type` — if `'video'`, route to `uploadVideoMultipart()`. If `'image'`, keep existing base64 upload flow (read base64 from uri via FileSystem if needed).
3. **Video validation (client-side):**
   - Duration: check `asset.duration` from picker result (milliseconds). Reject if > 300000 (5 min). The picker provides this directly — no need for `expo-av`.
   - MIME type: check `asset.mimeType` against allowed types (`video/mp4`, `video/quicktime`, `video/3gpp`, `video/webm`). Show error immediately for unsupported formats before uploading.
4. **Video upload:** Use `XMLHttpRequest` (not `fetch`) with a `FormData` body. This gives upload progress via `xhr.upload.onprogress`. Set `xhr.setRequestHeader('Authorization', 'Bearer ...')` for auth. Set `xhr.timeout = 300000` (5 min).
5. **Upload cancellation:** Add a cancel button during video uploads. Store the `XMLHttpRequest` instance in a ref, call `xhr.abort()` on cancel. Reset UI to idle state.
6. **Progress indicator:** Show `"{uploaded} MB / {total} MB"` during video uploads. For images, keep the existing counter ("2/3 hochgeladen…").
7. **Session ID capture:** Capture `sessionId` at the moment the user initiates upload, not at completion — user may switch tabs during a long video upload.
8. **Done state:** Video thumbnails with a play icon overlay. Display file size next to path.
9. **Gallery subtitle:** Update from "Bis zu 12 Bilder" to "Bilder & Videos (max 5 Min)".

### Server — `upload.handler.ts`

1. **Content-type routing:** Detect `Content-Type` header on `/upload/screenshot`:
   - `application/json` → existing base64 flow (images, 50 MB limit via body accumulation)
   - `multipart/form-data` → new streaming flow via `busboy` (videos, 500 MB limit)
2. **Multipart parsing:** Use `busboy` with `limits.fileSize: 500 * 1024 * 1024`. Stream file data directly to disk — do NOT accumulate the multipart body in memory.
3. **Temp file + rename pattern:** Write to a temp path (e.g., `{target}.tmp`) during upload. On success, rename to final path. On error/abort, delete the temp file. This prevents partial files from lingering.
4. **Allowed video MIME types:** `video/mp4`, `video/quicktime`, `video/3gpp`, `video/webm`
5. **Server-side size enforcement:** `busboy` `limits.fileSize` handles this at the stream level. Return 413 if exceeded.
6. **Filename:** Same pattern as images: `{timestamp}_{sanitized_basename}{ext}`
7. **Response:** Same shape: `{ path: string, filename: string }`

### Server — `index.ts`

- Add `/upload/media` as canonical route pointing to same handler. Keep `/upload/screenshot` as alias for backward compatibility.

### Shared — `protocol.ts`

- No changes. Path insertion uses existing `terminal:input` message.

### ToolRail — `ToolRail.tsx`

- Change label: `Screenshots` → `Medien`
- Icon: keep `image` or change to `film`

## What stays the same

- Terminal path insertion via `terminal:input` WebSocket message
- Bearer token authentication
- Camera button (remains image-only, unchanged)
- Drawing feature (completely untouched)
- File browser feature (untouched)
- Server config, port, JWT validation

## Dependencies

- `busboy` + `@types/busboy` — server-side multipart parser (npm)
- `expo-image-picker` `duration` field — video duration validation (already available, no new dependency)
- `expo-file-system` — already installed, needed to read file URI for FormData
