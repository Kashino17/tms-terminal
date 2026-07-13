import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Image,
  ScrollView,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { Feather } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system';
import { WebSocketService } from '../services/websocket.service';
import { colors, fonts } from '../theme';
import { useResponsive } from '../hooks/useResponsive';

interface Props {
  sessionId: string | undefined;
  wsService: WebSocketService;
  serverHost: string;
  serverPort: number;
  serverToken: string;
}

type UploadState = 'idle' | 'picking' | 'uploading' | 'done' | 'error';

const MAX_GALLERY_SELECTION = 12;

const MAX_VIDEO_DURATION_MS = 5 * 60 * 1000; // 5 minutes

const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/3gpp',
  'video/webm',
]);

export function ScreenshotPanel({ sessionId, wsService, serverHost, serverPort, serverToken }: Props) {
  const { rf, rs, ri } = useResponsive();
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [uploadedPaths, setUploadedPaths] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [pathCopied, setPathCopied] = useState(false);
  const [previewIsVideo, setPreviewIsVideo] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const [videoProgress, setVideoProgress] = useState<{ loaded: number; total: number } | null>(null);

  const lastPath = uploadedPaths.length > 0 ? uploadedPaths[uploadedPaths.length - 1] : null;

  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

  const reset = useCallback(() => {
    setUploadState('idle');
    setUploadedPaths([]);
    setUploadProgress({ current: 0, total: 0 });
    setPreviewUri(null);
    setErrorMsg('');
    setPathCopied(false);
    setPreviewIsVideo(false);
  }, []);

  const validateVideo = useCallback((asset: ImagePicker.ImagePickerAsset): string | null => {
    if (asset.duration && asset.duration > MAX_VIDEO_DURATION_MS) {
      const mins = Math.round(asset.duration / 60000);
      return `Video zu lang (${mins} Min, max 5 Min)`;
    }
    if (asset.mimeType && !ALLOWED_VIDEO_MIMES.has(asset.mimeType)) {
      return `Format nicht unterstützt: ${asset.mimeType}`;
    }
    return null;
  }, []);

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

  const cancelUpload = useCallback(() => {
    if (xhrRef.current) {
      xhrRef.current.abort();
      xhrRef.current = null;
    }
    setVideoProgress(null);
    reset();
  }, [reset]);

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
    if (assets.length > 0) {
      setPreviewUri(assets[0].uri);
      setPreviewIsVideo(assets[0].type === 'video');
    }

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

  const pickFromGallery = useCallback(async () => {
    setUploadState('picking');
    setErrorMsg('');
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setUploadState('error');
        setErrorMsg('Galerie-Zugriff verweigert');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsMultipleSelection: true,
        selectionLimit: MAX_GALLERY_SELECTION,
        quality: 1,
      });
      if (result.canceled || !result.assets?.length) {
        setUploadState('idle');
        return;
      }
      await uploadMultiple(result.assets);
    } catch (err: unknown) {
      setUploadState('error');
      setErrorMsg(err instanceof Error ? err.message : 'Unbekannter Fehler');
    }
  }, [uploadMultiple]);

  const pickFromCamera = useCallback(async () => {
    setUploadState('picking');
    setErrorMsg('');
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setUploadState('error');
        setErrorMsg('Kamera-Zugriff verweigert');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        base64: true,
      });
      if (result.canceled || !result.assets?.length) {
        setUploadState('idle');
        return;
      }
      await uploadMultiple(result.assets);
    } catch (err: unknown) {
      setUploadState('error');
      setErrorMsg(err instanceof Error ? err.message : 'Unbekannter Fehler');
    }
  }, [uploadMultiple]);

  const copyAllPaths = useCallback(async () => {
    if (!uploadedPaths.length) return;
    await Clipboard.setStringAsync(uploadedPaths.join('\n'));
    setPathCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setPathCopied(false), 1600);
  }, [uploadedPaths]);

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={[s.header, { paddingHorizontal: rs(12), paddingVertical: rs(10), gap: rs(7) }]}>
        <Feather name="film" size={ri(14)} color={colors.info} />
        <Text style={[s.title, { fontSize: rf(13) }]}>Medien</Text>
      </View>
      <View style={s.divider} />

      {/* Idle — pick buttons */}
      {uploadState === 'idle' && (
        <View style={s.body}>
          <Text style={[s.hint, { fontSize: rf(11) }]}>Bild oder Video hochladen → Pfad ins Terminal</Text>

          {/* Gallery button */}
          <TouchableOpacity
            style={[s.primaryBtn, { paddingVertical: rs(12), paddingHorizontal: rs(14), gap: rs(12) }]}
            onPress={pickFromGallery}
            activeOpacity={0.75}
            accessibilityLabel="Pick from gallery"
            accessibilityRole="button"
          >
            <Feather name="image" size={ri(22)} color={colors.info} />
            <View>
              <Text style={[s.primaryBtnLabel, { fontSize: rf(13) }]}>Galerie</Text>
              <Text style={[s.primaryBtnSub, { fontSize: rf(10) }]}>Bilder & Videos (max 5 Min)</Text>
            </View>
          </TouchableOpacity>

          {/* Camera button */}
          <TouchableOpacity
            style={[s.secondaryBtn, { paddingVertical: rs(12), paddingHorizontal: rs(14), gap: rs(12) }]}
            onPress={pickFromCamera}
            activeOpacity={0.75}
            accessibilityLabel="Take photo"
            accessibilityRole="button"
          >
            <Feather name="camera" size={ri(22)} color={colors.textMuted} />
            <View>
              <Text style={[s.secondaryBtnLabel, { fontSize: rf(13) }]}>Kamera</Text>
              <Text style={[s.secondaryBtnSub, { fontSize: rf(10) }]}>Foto aufnehmen</Text>
            </View>
          </TouchableOpacity>

          {/* Destination hint */}
          <View style={s.destRow}>
            <Text style={s.destLabel}>Ziel</Text>
            <Text style={s.destPath}>~/Desktop/Screenshots/</Text>
          </View>
        </View>
      )}

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

      {/* Done */}
      {uploadState === 'done' && uploadedPaths.length > 0 && (
        <View style={s.body}>
          {/* Thumbnail */}
          {previewUri && (
            <View style={s.thumbWrap}>
              <Image source={{ uri: previewUri }} style={s.thumb} resizeMode="cover" />
              <View style={s.thumbBadge}>
                <Feather name="check" size={12} color={colors.bg} />
              </View>
              {previewIsVideo && (
                <View style={s.playOverlay}>
                  <Feather name="play" size={24} color="#fff" />
                </View>
              )}
              {uploadedPaths.length > 1 && (
                <View style={s.thumbCount}>
                  <Text style={s.thumbCountTxt}>{uploadedPaths.length}</Text>
                </View>
              )}
            </View>
          )}

          <Text style={s.successLabel}>
            {uploadedPaths.length === 1
              ? 'Hochgeladen & verlinkt'
              : `${uploadedPaths.length} Dateien hochgeladen`}
          </Text>
          {errorMsg ? <Text style={s.partialError}>{errorMsg}</Text> : null}

          {/* Path box — scrollable for multiple */}
          <ScrollView style={s.pathScroll} nestedScrollEnabled>
            <View style={s.pathBox}>
              {uploadedPaths.map((p, i) => (
                <Text key={i} style={s.pathTxt} numberOfLines={2}>
                  {uploadedPaths.length > 1 ? `${i + 1}. ` : ''}{p}
                </Text>
              ))}
            </View>
          </ScrollView>

          {/* Actions */}
          <View style={s.actionRow}>
            <TouchableOpacity
              style={[s.actionBtn, s.actionBtnCopy, pathCopied && s.actionBtnCopied]}
              onPress={copyAllPaths}
              activeOpacity={0.75}
              accessibilityLabel={pathCopied ? 'Paths copied' : 'Copy file paths'}
              accessibilityRole="button"
            >
              <View style={s.actionBtnInner}>
                <Feather name={pathCopied ? 'check' : 'copy'} size={12} color={pathCopied ? colors.accent : colors.primary} />
                <Text style={[s.actionBtnTxt, pathCopied && s.actionBtnTxtCopied]}>
                  {pathCopied
                    ? 'Kopiert'
                    : uploadedPaths.length > 1
                      ? `${uploadedPaths.length} Pfade kopieren`
                      : 'Pfad kopieren'}
                </Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity style={[s.actionBtn, s.actionBtnAgain]} onPress={reset} activeOpacity={0.75}>
              <Text style={s.actionBtnTxtMuted}>Weiteres</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Error */}
      {uploadState === 'error' && (
        <View style={s.centered}>
          <Feather name="alert-triangle" size={28} color={colors.destructive} />
          <Text style={s.errorText}>{errorMsg}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={reset} activeOpacity={0.75}>
            <Text style={s.retryTxt}>Erneut versuchen</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 7,
  },
  title: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(51,65,85,0.7)',
  },
  body: {
    paddingHorizontal: 12,
    paddingTop: 14,
    gap: 10,
  },
  hint: {
    color: colors.textDim,
    fontSize: 11,
    marginBottom: 2,
  },

  // ── Buttons
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  primaryBtnLabel: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  primaryBtnSub: {
    color: colors.textDim,
    fontSize: 10,
    marginTop: 1,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  secondaryBtnLabel: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  secondaryBtnSub: {
    color: colors.textDim,
    fontSize: 10,
    marginTop: 1,
  },

  // ── Destination hint
  destRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    paddingHorizontal: 2,
  },
  destLabel: {
    color: colors.textDim,
    fontSize: 10,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  destPath: {
    color: colors.textDim,
    fontSize: 10,
    fontFamily: fonts.mono,
  },

  // ── Centered states
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 16,
  },
  loadingText: {
    color: colors.textDim,
    fontSize: 12,
  },

  // ── Done state
  thumbWrap: {
    alignSelf: 'center',
    width: 120,
    height: 80,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#313244',
    marginBottom: 2,
  },
  thumb: {
    width: 120,
    height: 80,
  },
  thumbBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbCount: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  thumbCountTxt: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
  },
  successLabel: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  pathScroll: {
    maxHeight: 120,
  },
  pathBox: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  partialError: {
    color: colors.warning,
    fontSize: 10,
    textAlign: 'center',
  },
  pathTxt: {
    color: colors.info,
    fontSize: 10,
    fontFamily: fonts.mono,
    lineHeight: 15,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 1,
  },
  actionBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  actionBtnCopy: {
    backgroundColor: 'rgba(59,130,246,0.08)',
    borderColor: colors.border,
  },
  actionBtnCopied: {
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderColor: colors.accent,
  },
  actionBtnTxt: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '700',
  },
  actionBtnTxtCopied: { color: colors.accent },
  actionBtnAgain: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    flex: 0,
    paddingHorizontal: 14,
  },
  actionBtnTxtMuted: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '600',
  },

  // ── Error state
  errorText: {
    color: colors.destructive,
    fontSize: 12,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 4,
    paddingVertical: 8,
    paddingHorizontal: 18,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
  retryTxt: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
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
});
